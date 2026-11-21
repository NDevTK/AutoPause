'use strict';
/* global chrome */
var state = {};

const resumelimit = 5;
const shortMediaDuration = 3; // seconds
const shortMediaDebounce = 5000; // ms, for tabs without content script access
const pendingAudible = new Map();
const deniedAudible = new Map();
const pendingPipTokens = new Map();
const setItems = [
  'media',
  'backgroundaudio',
  'otherTabs',
  'mutedTabs',
  'ignoredTabs',
  'mutedMedia',
  'legacyMedia'
];

var options = {};

state.media = new Set(); // List of tabs with media.
state.backgroundaudio = new Set();
state.mediaPlaying = null; // Tab ID of active media.
state.activeTab = null;
state.activeWindow = null;
state.lastPlaying = null;
state.otherTabs = new Set(); // Tab IDs of media with no permission to access.
state.mutedTabs = new Set(); // Tab IDs of all muted media.
state.ignoredTabs = new Set();
state.mutedMedia = new Set(); // Tab IDs of resumable muted media.
state.legacyMedia = new Set(); // Tab IDs of old media.
state.autoPauseWindow = null;
state.locked = false;
state.resumeOnUnlock = false;
state.pipTabs = {}; // Map of Document PiP tabId -> {openerTabId, openerDocumentId, pipDocumentId}.

function markDeniedAudible(tabId) {
  if (deniedAudible.has(tabId)) clearTimeout(deniedAudible.get(tabId));
  deniedAudible.set(
    tabId,
    setTimeout(() => deniedAudible.delete(tabId), 1000)
  );
}

function clearDeniedAudible(tabId) {
  if (deniedAudible.has(tabId)) {
    clearTimeout(deniedAudible.get(tabId));
    deniedAudible.delete(tabId);
  }
}

let resolveInitialization;
const initializationCompletePromise = new Promise((resolve) => {
  resolveInitialization = resolve;
});

async function save() {
  let temp = Object.assign({}, state);
  for (let value of setItems) {
    temp[value] = [...temp[value]];
  }
  let result = await chrome.storage.session.set({state: temp});
}

var exclude = [];

// https://github.com/NDevTK/AutoPause/issues/31
const unsupportedWindowScripts = ['https://*.netflix.com/*'];
const unsupportedScripts = [];

const matchPatternRegex =
  /^(?:(https?|ftp|\*):\/\/(\*|(?:\*\.)?[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)|file:\/\/[^*/:\s]*)\/.*$/;

function filterValidPatterns(patterns) {
  return patterns.filter(
    (pattern) =>
      typeof pattern === 'string' &&
      (pattern === '<all_urls>' || matchPatternRegex.test(pattern))
  );
}

async function restrictStorageAccess() {
  const accessOptions = {accessLevel: 'TRUSTED_CONTEXTS'};
  const areas = ['sync', 'local', 'managed', 'session'];
  await Promise.allSettled(
    areas.map(async (area) => {
      if (typeof chrome.storage[area]?.setAccessLevel === 'function') {
        await chrome.storage[area].setAccessLevel(accessOptions);
      }
    })
  );
}

async function restore() {
  // chrome.storage.session is ephemeral (cleared on browser restart or extension update).
  // Never add backwards-compatibility or value-normalization logic here.
  let result = await chrome.storage.session.get('state');
  if (typeof result.state === 'object' && result.state !== null) {
    // Support Set();
    for (let value of setItems) {
      result.state[value] = new Set(result.state[value]);
    }
    state = result.state;
  }
  let result2 = await chrome.storage.sync.get(['options', 'exclude']);
  if (
    typeof result2.options === 'object' &&
    result2.options !== null &&
    !Array.isArray(result2.options)
  )
    options = result2.options;
  if (Array.isArray(result2.exclude))
    exclude = filterValidPatterns(result2.exclude);
  resolveInitialization();
}

restore();

// Security: Storage areas are restricted to trusted contexts where supported
// (Chrome 140+), but older Chrome and Firefox still expose sync to content scripts.
chrome.storage.onChanged.addListener(async (result, areaName) => {
  if (areaName !== 'sync') return;
  await initializationCompletePromise;
  if (
    typeof result.options?.newValue === 'object' &&
    result.options.newValue !== null &&
    !Array.isArray(result.options.newValue)
  ) {
    const hadMuteOnPause =
      hasProperty(options, 'muteonpause') ||
      (typeof result.options.oldValue === 'object' &&
        result.options.oldValue !== null &&
        hasProperty(result.options.oldValue, 'muteonpause'));
    options = result.options.newValue;
    if (state.locked && !hasProperty(options, 'checkidle')) {
      state.locked = false;
      state.resumeOnUnlock = false;
      save();
    }
    if (hadMuteOnPause && !hasProperty(options, 'muteonpause')) {
      chrome.tabs.query({muted: true}, (tabs) => {
        if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
        for (const tab of tabs) {
          if (tab.mutedInfo?.extensionId === chrome.runtime.id) {
            chrome.tabs.update(tab.id, {muted: false}, () => {
              const err = chrome.runtime.lastError;
              if (err && !/No tab with id/i.test(err.message)) {
                console.warn('AutoPause unmute:', err.message);
              }
            });
          }
        }
      });
    }
  }
  if (Array.isArray(result.exclude?.newValue)) {
    exclude = filterValidPatterns(result.exclude.newValue);
    updateContentScripts();
  }
});

// On install display the options page so the user can give permissions.
chrome.runtime.onInstalled.addListener(async (details) => {
  await restrictStorageAccess();
  await initializationCompletePromise;
  updateExtensionScripts();
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

function onMute(tabId) {
  state.mutedTabs.add(tabId);
  state.media.delete(tabId);
  // Pause hidden muted tabs.
  pause(tabId, true);
  onPause(tabId);
  save();
}

chrome.runtime.onMessage.addListener(async (message, sender) => {
  await initializationCompletePromise;
  // Security: Messages are from untrusted website content scripts.
  if (
    typeof message !== 'object' ||
    message === null ||
    typeof sender.tab?.id !== 'number' ||
    (sender.documentLifecycle && sender.documentLifecycle !== 'active')
  )
    return;
  invalidateMismatchedDocPiPLinks(sender);
  if (message.type === 'docPiPOpen') {
    registerDocPiPToken('opener', message.body, sender);
    return;
  }
  if (message.type === 'docPiPChild') {
    registerDocPiPToken('child', message.body, sender);
    return;
  }
  const openerTab = await getDocPiPOpener(sender.tab);
  const tab = openerTab
    ? sender.tab.audible
      ? {...openerTab, audible: true}
      : openerTab
    : sender.tab;
  if (state.ignoredTabs.has(tab.id)) return;
  if (state.autoPauseWindow !== null && state.autoPauseWindow !== tab.windowId)
    return;
  switch (message.type) {
    case 'hidden':
      if (await visablePopup(tab.id)) break;
      if (state.mutedTabs.has(tab.id)) {
        // Pause hidden muted tabs.
        pause(tab.id);
      }
      break;
    case 'play':
      if (
        tab.mutedInfo?.muted &&
        tab.mutedInfo.extensionId !== chrome.runtime.id
      ) {
        if (pendingAudible.has(tab.id)) {
          clearTimeout(pendingAudible.get(tab.id));
          pendingAudible.delete(tab.id);
        }
        state.otherTabs.delete(tab.id);
        state.mutedMedia.add(tab.id);
        onMute(tab.id);
      } else {
        // Ignore short media (e.g. notification sounds) when option is enabled.
        if (
          hasProperty(options, 'ignoreshort') &&
          typeof message.duration === 'number' &&
          Number.isFinite(message.duration) &&
          message.duration > 0 &&
          message.duration < shortMediaDuration
        )
          break;
        if (pendingAudible.has(tab.id)) {
          clearTimeout(pendingAudible.get(tab.id));
          pendingAudible.delete(tab.id);
        }
        state.otherTabs.delete(tab.id);
        state.mutedMedia.delete(tab.id);
        state.media.add(tab.id);
        const playTab =
          !tab.audible && (await isGroupAudible(tab))
            ? {...tab, audible: true}
            : tab;
        onPlay(
          playTab,
          message.body,
          message.userActivation === true,
          message.wasPaused === true,
          sender
        );
      }
      break;
    case 'playMuted':
      if (await isPlaying(tab.id)) break;
      state.mutedMedia.delete(tab.id);
      onMute(tab.id);
      break;
    case 'pause':
      if (await isPlaying(tab.id)) break;
      remove(tab.id);
      break;
    case 'tabFocus': {
      // Security: Verify the action is actually a real tab activation (documentPictureInPicture)
      if (sender.frameId !== 0 || openerTab) break;
      const focusedTabs = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
      });
      if (focusedTabs.length !== 1) break;
      const pipEntry = getDocPiPEntry(focusedTabs[0].id);
      if (!pipEntry || pipEntry.openerTabId !== tab.id) break;
      if (
        pipEntry.openerDocumentId !== null &&
        sender.documentId !== pipEntry.openerDocumentId
      ) {
        break;
      }
      tabChange(tab);
      break;
    }
  }
  save();
});

chrome.tabs.onReplaced.addListener(async (newId, oldId) => {
  await initializationCompletePromise;
  if (state.ignoredTabs.has(oldId)) {
    state.ignoredTabs.add(newId);
    state.ignoredTabs.delete(oldId);
  }
  const pipOpenerId = deleteDocPiPLinksForTab(oldId);
  remove(oldId, pipOpenerId, false);
  save();
});

function sendNormalPlayback(tabId, sender) {
  if (sender?.tab?.id !== undefined) {
    const target =
      typeof sender.documentId === 'string'
        ? {documentId: sender.documentId}
        : typeof sender.frameId === 'number'
          ? {frameId: sender.frameId}
          : null;
    const req = target
      ? chrome.tabs.sendMessage(
          sender.tab.id,
          {type: 'normalPlayback'},
          target
        )
      : chrome.tabs.sendMessage(sender.tab.id, {type: 'normalPlayback'});
    req?.catch?.((err) => {
      if (
        !/Receiving end does not exist|Could not establish connection|No tab with id|message channel closed|message port closed/i.test(
          err?.message || ''
        )
      ) {
        console.warn('AutoPause normalPlayback:', err);
      }
    });
  } else {
    send(tabId, 'normalPlayback');
  }
}

function onPlay(
  tab,
  id = '',
  userActivation = false,
  wasPaused = false,
  sender = null
) {
  // Security: userActivation is from untrusted website content scripts however the isolated world should prevent attacks.
  if (state.autoPauseWindow !== null && state.autoPauseWindow !== tab.windowId)
    return;

  if (hasProperty(options, 'ignoreother') && state.otherTabs.has(tab.id))
    return;

  if (hasProperty(options, 'multipletabs') && tab.id !== state.activeTab) {
    if (state.locked || (wasPaused && !userActivation)) {
      if (wasPaused) markDeniedAudible(tab.id);
      return pause(tab.id);
    }
    if (wasPaused) {
      clearDeniedAudible(tab.id);
      if (hasProperty(options, 'muteonpause')) setTabMuted(tab.id, false);
      sendNormalPlayback(tab.id, sender);
    }
    return;
  }
  // Dont allow a diffrent tab to hijack active media.
  if (denyPlay(tab, userActivation, wasPaused)) {
    if (wasPaused) markDeniedAudible(tab.id);
    return pause(tab.id);
  }
  clearDeniedAudible(tab.id);
  state.mediaPlaying = tab.id;

  if (hasProperty(options, 'muteonpause')) setTabMuted(tab.id, false);

  if (
    hasProperty(options, 'permediapause') &&
    typeof id === 'string' &&
    id.length === 36
  )
    send(tab.id, 'pauseOther', id);

  if (wasPaused) {
    sendNormalPlayback(tab.id, sender);
  }

  if (
    tab.id === state.activeTab ||
    userActivation ||
    (tab.audible && tab.id === state.lastPlaying)
  )
    state.lastPlaying = null;
  if (state.media.has(tab.id)) {
    state.legacyMedia.delete(tab.id);
    state.mutedTabs.delete(tab.id);
    // Make tab top priority.
    state.media.delete(tab.id);
    state.media.add(tab.id);
    if (hasProperty(options, 'resumelimit') && state.media.size > resumelimit) {
      const mediaList = [...state.media];
      for (let i = 0; i < mediaList.length - resumelimit; i++) {
        state.legacyMedia.add(mediaList[i]);
      }
    }
  }
  // Pause all other media.
  if (tab.audible) pauseOther(tab.id);
  save();
}

function onPause(id) {
  // Ignore event from other tabs.
  if (id === state.mediaPlaying) {
    state.lastPlaying = id;
    autoResume(id);
    if (state.mediaPlaying === id) state.mediaPlaying = null;
  }
  save();
}

async function tabChange(tab) {
  if (!tab) return;
  if (state.ignoredTabs.has(tab.id)) return;

  if (state.autoPauseWindow !== null && state.autoPauseWindow !== tab.windowId)
    return;

  state.activeTab = tab.id;
  state.activeWindow = tab.windowId;
  save();

  if (hasProperty(options, 'ignoretabchange')) return;

  if (hasProperty(options, 'pauseoninactive')) {
    // Pause all except active, last playing, backgroundaudio tab
    pauseOther(tab.id, true, true);
  }

  if (state.media.has(tab.id) || state.mutedTabs.has(tab.id)) {
    play(tab.id);
  } else if (state.otherTabs.has(tab.id)) {
    const playTab =
      !tab.audible && (await isGroupAudible(tab))
        ? {...tab, audible: true}
        : tab;
    onPlay(playTab);
  }
  save();
}

function getResumeTab(exclude, manual = false) {
  // Prefer the active tab
  if (state.media.has(state.activeTab) && state.activeTab !== exclude) {
    return state.activeTab;
  }

  const pickFrom = (tabs, ignoreLimit) => {
    const resumable = Array.from(tabs).filter(
      (id) =>
        id !== exclude &&
        state.media.has(id) &&
        (ignoreLimit ||
          !hasProperty(options, 'resumelimit') ||
          !state.legacyMedia.has(id) ||
          state.backgroundaudio.has(id))
    );
    return resumable.length > 0 ? resumable.pop() : false;
  };

  if (
    state.backgroundaudio.size > 0 ||
    hasProperty(options, 'pauseoninactive') ||
    hasProperty(options, 'noauto')
  ) {
    const bgResult = pickFrom(state.backgroundaudio, manual);
    if (bgResult !== false || !manual) return bgResult;
  }

  return pickFrom(state.media, manual);
}

// User may have mutiple windows open.
chrome.windows.onFocusChanged.addListener(async (id) => {
  await initializationCompletePromise;
  if (id === chrome.windows.WINDOW_ID_NONE) return;
  setTimeout(async () => {
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });
    if (tabs.length !== 1) return;
    const targetTab = (await getDocPiPOpener(tabs[0])) || tabs[0];
    if (
      state.autoPauseWindow !== null &&
      state.autoPauseWindow !== targetTab.windowId
    )
      return;
    if (
      targetTab.id === state.activeTab &&
      targetTab.windowId === state.activeWindow
    )
      return;
    state.activeWindow = targetTab.windowId;
    tabChange(targetTab);
    save();
  }, 200);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await initializationCompletePromise;
  let changed = false;
  if (state.activeWindow === windowId) {
    state.activeWindow = null;
    changed = true;
  }
  if (state.autoPauseWindow === windowId) {
    state.autoPauseWindow = null;
    changed = true;
  }
  if (changed) save();
});

// Dont track unrelated windows
chrome.tabs.onDetached.addListener(async (id) => {
  await initializationCompletePromise;
  if (state.autoPauseWindow === null) return;
  releaseTab(id);
  save();
});

function focusTab(tabId) {
  chrome.tabs.update(tabId, {active: true}, (tab) => {
    const err = chrome.runtime.lastError;
    if (err) {
      if (!/No tab with id/i.test(err.message)) {
        console.warn('AutoPause gotoaudible:', err.message);
      }
      return;
    }
    if (
      tab &&
      typeof tab.windowId === 'number' &&
      tab.windowId !== chrome.windows.WINDOW_ID_NONE &&
      tab.windowId !== state.activeWindow
    ) {
      chrome.windows.update(tab.windowId, {focused: true}, () => {
        const winErr = chrome.runtime.lastError;
        if (winErr && !/No window with id/i.test(winErr.message)) {
          console.warn('AutoPause gotoaudible window:', winErr.message);
        }
      });
    }
  });
}

// Handle keyboard shortcuts.
async function handleCommand(command) {
  await initializationCompletePromise;
  // Security: Websites might trick the user into running commands.
  switch (command) {
    case 'gotoaudible':
      // Go to audible tab thats not active.
      chrome.tabs.query(
        {
          audible: true,
          active: false,
          currentWindow: true
        },
        (tabs) => {
          if (chrome.runtime.lastError) {
            console.warn(
              'AutoPause gotoaudible query:',
              chrome.runtime.lastError.message
            );
            return;
          }
          if (tabs.length > 0) {
            focusTab(tabs[0].id);
          } else if (state.media.size > 0) {
            const result = getResumeTab(state.activeTab, true);
            if (result !== false) {
              focusTab(result);
            }
          }
        }
      );
      break;
    case 'disableresume':
      toggleOption('disableresume');
      break;
    case 'toggleFastPlayback':
      Broadcast('toggleFastPlayback');
      break;
    case 'Rewind':
      Broadcast('Rewind');
      break;
    case 'togglePlayback':
      if (state.mediaPlaying !== null) {
        state.mediaPlaying = null;
        pauseAll();
      } else if (!state.locked) {
        const result = getResumeTab(undefined, true);
        if (result !== false) {
          // Ignore pause event due to this hotkey
          state.lastPlaying = null;
          state.mediaPlaying = result;
          play(result, true);
        }
      }
      break;
    case 'next':
      Broadcast('next');
      break;
    case 'previous':
      Broadcast('previous');
      break;
    case 'pauseoninactive':
      toggleOption('pauseoninactive');
      break;
    case 'backgroundaudio': {
      const targetTab = await getFocusedTargetTab();
      const tabId = targetTab ? targetTab.id : state.activeTab;
      if (typeof tabId !== 'number') break;
      if (state.backgroundaudio.has(tabId)) {
        state.backgroundaudio.delete(tabId);
      } else {
        // Currently only has one tab
        state.backgroundaudio.clear();
        state.backgroundaudio.add(tabId);
      }
      break;
    }
    case 'ignoretab': {
      const targetTab = await getFocusedTargetTab();
      const tabId = targetTab ? targetTab.id : state.activeTab;
      if (typeof tabId !== 'number') break;
      if (state.ignoredTabs.has(tabId)) {
        state.ignoredTabs.delete(tabId);
        if (targetTab) {
          state.activeTab = targetTab.id;
          state.activeWindow = targetTab.windowId;
        }
        send(tabId, 'new');
        if (targetTab?.audible) send(tabId, 'play');
      } else {
        state.ignoredTabs.add(tabId);
        releaseTab(tabId);
      }
      break;
    }
    case 'previoustab':
      state.lastPlaying = null;
      switchMedia(true);
      break;
    case 'autopausewindow': {
      const targetTab = await getFocusedTargetTab();
      if (targetTab && targetTab.windowId !== chrome.windows.WINDOW_ID_NONE) {
        if (state.autoPauseWindow === targetTab.windowId) {
          state.autoPauseWindow = null;
        } else {
          state.autoPauseWindow = targetTab.windowId;
          const trackedIds = new Set([
            ...state.media,
            ...state.mutedTabs,
            ...state.mutedMedia,
            ...state.otherTabs,
            ...state.backgroundaudio
          ]);
          const outsideIds = [];
          await Promise.all(
            [...trackedIds].map(async (tabId) => {
              try {
                const t = await chrome.tabs.get(tabId);
                if (t.windowId !== state.autoPauseWindow) {
                  outsideIds.push(tabId);
                }
              } catch (err) {
                if (/No tab with id/i.test(err?.message || '')) {
                  remove(tabId, null, false);
                } else {
                  console.warn('AutoPause autopausewindow:', err);
                }
              }
            })
          );
          let playingOutside = null;
          for (const tabId of outsideIds) {
            if (tabId === state.mediaPlaying) {
              playingOutside = tabId;
            } else {
              releaseTab(tabId);
            }
          }
          if (playingOutside !== null) {
            releaseTab(playingOutside);
          }
        }
      }
      break;
    }
  }
  save();
}

chrome.commands.onCommand.addListener(handleCommand);

async function getFocusedTargetTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });
  if (tabs.length !== 1) return null;
  return (await getDocPiPOpener(tabs[0])) || tabs[0];
}

function setTabMuted(id, muted) {
  const onDone = () => {
    const err = chrome.runtime.lastError;
    if (err && !/No tab with id/i.test(err.message)) {
      console.warn('AutoPause setTabMuted:', err.message);
    }
  };
  chrome.tabs.update(id, {muted}, onDone);
  for (const pipId of getDocPiPChildIds(id)) {
    chrome.tabs.update(pipId, {muted}, onDone);
  }
}

async function unmuteIfOwned(ownerTabId, pipIds = []) {
  const ids = [ownerTabId, ...pipIds];
  await Promise.all(
    ids.map(async (id) => {
      try {
        const tab = await chrome.tabs.get(id);
        if (hasProperty(options, 'muteonpause') && state.media.has(ownerTabId))
          return;
        if (
          tab?.mutedInfo?.muted &&
          tab.mutedInfo.extensionId === chrome.runtime.id
        ) {
          await chrome.tabs.update(id, {muted: false});
        }
      } catch (err) {
        if (!/No tab with id/i.test(err?.message || '')) {
          console.warn('AutoPause unmuteIfOwned:', err);
        }
      }
    })
  );
}

function releaseTab(tabId) {
  const pipIds = getDocPiPChildIds(tabId);
  if (state.media.has(tabId) || state.mutedTabs.has(tabId)) {
    send(tabId, 'allowplayback');
  }
  remove(tabId, null, true, pipIds);
}

function pause(id, checkHidden) {
  // Security: Leaks to websites that a different tab is audible or shotcut usage, Boring DoS.
  if (checkHidden) {
    if (!state.otherTabs.has(id)) send(id, 'hidden');
    return;
  }
  if (hasProperty(options, 'nopermission')) {
    chrome.tabs.discard(id)?.catch?.((err) => {
      if (!/No tab with id|Cannot discard/i.test(err?.message || '')) {
        console.warn('AutoPause discard:', err);
      }
    });
    return;
  }
  if (state.otherTabs.has(id)) return;
  if (hasProperty(options, 'muteonpause') && !state.mutedTabs.has(id))
    setTabMuted(id, true);
  send(id, 'pause');
}

function play(id, force) {
  // Security: If muteonpause is enabled need to ensure a tab is not unmuted when not wanted.
  if (state.locked) return;
  clearDeniedAudible(id);
  if (hasProperty(options, 'muteonpause') && !state.mutedTabs.has(id))
    setTabMuted(id, false);
  if (hasProperty(options, 'disableresume') && !force) {
    send(id, 'allowplayback');
  } else {
    send(id, 'play');
  }
}

function switchMedia(force = false) {
  if (state.locked) return;
  const result = getResumeTab(state.mediaPlaying, force);
  if (result !== false) {
    state.mediaPlaying = result;
    play(result, force);
  }
}

function autoResume(id) {
  if (
    hasProperty(options, 'disableresume') ||
    state.media.size === 0 ||
    (state.otherTabs.size > 0 && !hasProperty(options, 'ignoreother')) ||
    state.locked
  )
    return;
  if (
    hasProperty(options, 'multipletabs') &&
    state.backgroundaudio.size === 0 &&
    !hasProperty(options, 'pauseoninactive') &&
    !hasProperty(options, 'noauto')
  ) {
    // Resume all tabs when multipletabs is enabled.
    state.media.forEach((mediaId) => {
      if (
        mediaId !== id &&
        (!hasProperty(options, 'resumelimit') ||
          !state.legacyMedia.has(mediaId))
      ) {
        state.mediaPlaying = mediaId;
        play(mediaId);
      }
    });
    return;
  }
  // Make sure event is from the mediaPlaying tab.
  if (id === state.mediaPlaying) {
    switchMedia();
  }
}

// On tab change
chrome.tabs.onActivated.addListener(async (info) => {
  await initializationCompletePromise;
  chrome.tabs.get(info.tabId, async (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    const targetTab = (await getDocPiPOpener(tab)) || tab;
    if (
      state.activeWindow !== null &&
      targetTab.windowId !== state.activeWindow
    ) {
      return;
    }
    tabChange(targetTab);
    save();
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await initializationCompletePromise;
  const pipCountBefore = Object.keys(state.pipTabs).length;
  const pipOpenerId = deleteDocPiPLinksForTab(tabId);
  if (Object.keys(state.pipTabs).length !== pipCountBefore) save();
  setTimeout(() => {
    state.ignoredTabs.delete(tabId);
    remove(tabId, pipOpenerId, false);
    save();
  }, 200);
});

function remove(
  tabId,
  removedPipOpenerId = null,
  unmute = true,
  extraPipIds = []
) {
  const pipIds = [...new Set([...getDocPiPChildIds(tabId), ...extraPipIds])];
  const wasMutedTab = state.mutedTabs.has(tabId);
  let pipOpenerId = removedPipOpenerId;
  const entry = getDocPiPEntry(tabId);
  if (entry) {
    if (pipOpenerId === null) pipOpenerId = entry.openerTabId;
    delete state.pipTabs[tabId];
  }
  state.media.delete(tabId);
  state.mutedMedia.delete(tabId);
  state.otherTabs.delete(tabId);
  state.backgroundaudio.delete(tabId);
  state.mutedTabs.delete(tabId);
  state.legacyMedia.delete(tabId);
  if (pendingAudible.has(tabId)) {
    clearTimeout(pendingAudible.get(tabId));
    pendingAudible.delete(tabId);
  }
  clearDeniedAudible(tabId);
  if (unmute && !wasMutedTab) unmuteIfOwned(tabId, pipIds);
  onPause(tabId);
  if (pipOpenerId !== null) {
    (async () => {
      if (state.otherTabs.has(pipOpenerId)) {
        try {
          const openerTab = await chrome.tabs.get(pipOpenerId);
          if (!openerTab.audible) {
            remove(pipOpenerId);
            save();
          }
        } catch {
          remove(pipOpenerId, null, false);
          save();
        }
      } else if (
        (state.media.has(pipOpenerId) || state.mutedMedia.has(pipOpenerId)) &&
        !(await isPlaying(pipOpenerId))
      ) {
        remove(pipOpenerId);
        save();
      }
    })();
  }
}

function getDocPiPEntry(tabId) {
  if (typeof tabId !== 'number' || !hasProperty(state.pipTabs, tabId)) {
    return null;
  }
  const entry = state.pipTabs[tabId];
  if (
    typeof entry !== 'object' ||
    entry === null ||
    typeof entry.openerTabId !== 'number'
  ) {
    delete state.pipTabs[tabId];
    return null;
  }
  return entry;
}

function getDocPiPChildIds(openerTabId) {
  const ids = [];
  for (const [pipId, entry] of Object.entries(state.pipTabs)) {
    if (entry?.openerTabId === openerTabId) ids.push(Number(pipId));
  }
  return ids;
}

function deleteDocPiPLinksForTab(tabId) {
  let pipOpenerId = null;
  const entry = getDocPiPEntry(tabId);
  if (entry) {
    pipOpenerId = entry.openerTabId;
    delete state.pipTabs[tabId];
  }
  for (const [pipId, pipEntry] of Object.entries(state.pipTabs)) {
    if (pipEntry?.openerTabId === tabId) {
      delete state.pipTabs[pipId];
    }
  }
  return pipOpenerId;
}

function invalidateMismatchedDocPiPLinks(sender) {
  if (sender.frameId !== 0 || typeof sender.documentId !== 'string') return;
  const senderTabId = sender.tab.id;
  let changed = false;
  const childEntry = getDocPiPEntry(senderTabId);
  if (
    childEntry &&
    childEntry.pipDocumentId !== null &&
    childEntry.pipDocumentId !== sender.documentId
  ) {
    delete state.pipTabs[senderTabId];
    changed = true;
  }
  for (const [pipId, entry] of Object.entries(state.pipTabs)) {
    if (
      entry?.openerTabId === senderTabId &&
      entry.openerDocumentId !== null &&
      entry.openerDocumentId !== sender.documentId
    ) {
      delete state.pipTabs[pipId];
      changed = true;
    }
  }
  if (changed) save();
}

async function isGroupAudible(tab, excludePipId = null) {
  if (tab.audible) return true;
  const pipIds = getDocPiPChildIds(tab.id);
  for (const pipId of pipIds) {
    if (pipId === excludePipId) continue;
    try {
      const pipTab = await chrome.tabs.get(pipId);
      if (pipTab.audible) return true;
    } catch {
      delete state.pipTabs[pipId];
      save();
    }
  }
  return false;
}

function registerDocPiPToken(role, token, sender) {
  if (
    sender.frameId !== 0 ||
    typeof token !== 'string' ||
    token.length !== 36 ||
    typeof sender.origin !== 'string' ||
    sender.origin === 'null'
  ) {
    return;
  }
  if (role === 'child' && sender.url !== 'about:blank') return;
  if (
    role === 'opener' &&
    state.autoPauseWindow !== null &&
    state.autoPauseWindow !== sender.tab.windowId
  ) {
    return;
  }
  let entry = pendingPipTokens.get(token);
  if (!entry) {
    if (pendingPipTokens.size >= 50) return;
    entry = {
      timer: setTimeout(() => pendingPipTokens.delete(token), 5000)
    };
    pendingPipTokens.set(token, entry);
  }
  entry[role] = {
    tabId: sender.tab.id,
    origin: sender.origin,
    documentId: typeof sender.documentId === 'string' ? sender.documentId : null
  };
  if (entry.opener && entry.child) {
    clearTimeout(entry.timer);
    pendingPipTokens.delete(token);
    if (
      entry.opener.origin === entry.child.origin &&
      entry.opener.tabId !== entry.child.tabId
    ) {
      state.pipTabs[entry.child.tabId] = {
        openerTabId: entry.opener.tabId,
        openerDocumentId: entry.opener.documentId,
        pipDocumentId: entry.child.documentId
      };
      save();
    }
  }
}

async function getDocPiPOpener(tab) {
  const entry = getDocPiPEntry(tab?.id);
  if (!entry) return null;
  try {
    return await chrome.tabs.get(entry.openerTabId);
  } catch {
    delete state.pipTabs[tab.id];
    save();
    return null;
  }
}

// Detect changes to audible status of tabs
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await initializationCompletePromise;
  if (changeInfo.discarded) {
    const pipOpenerId = deleteDocPiPLinksForTab(tabId);
    if (
      !state.ignoredTabs.has(tabId) &&
      (state.autoPauseWindow === null || state.autoPauseWindow === tab.windowId)
    ) {
      remove(tabId, pipOpenerId);
      save();
    }
    return;
  }
  const hasAudible = hasProperty(changeInfo, 'audible');
  const hasExternalMute =
    hasProperty(changeInfo, 'mutedInfo') &&
    changeInfo.mutedInfo.extensionId !== chrome.runtime.id;
  if (!hasAudible && !hasExternalMute) return;

  const origTabId = tabId;
  const openerTab = await getDocPiPOpener(tab);
  if (openerTab) {
    tabId = openerTab.id;
    tab = hasAudible ? {...openerTab, audible: changeInfo.audible} : openerTab;
  }
  if (state.autoPauseWindow !== null && state.autoPauseWindow !== tab.windowId)
    return;
  if (state.ignoredTabs.has(tabId)) return;

  if (hasExternalMute) {
    if (changeInfo.mutedInfo.muted && state.media.has(tabId)) {
      state.mutedMedia.add(tabId);
      onMute(tabId);
    }
    // If tab gets unmuted resume it.
    else if (
      !changeInfo.mutedInfo.muted &&
      (state.mutedMedia.has(tabId) ||
        (hasProperty(options, 'muteonpause') && state.media.has(tabId)))
    ) {
      if (!state.locked) {
        state.mutedMedia.delete(tabId);
        state.mutedTabs.delete(tabId);
        state.lastPlaying = null;
        state.mediaPlaying = tabId;
        play(tabId, true);
      }
    } else if (changeInfo.mutedInfo.muted && state.otherTabs.has(tabId)) {
      state.otherTabs.delete(tabId);
      onPause(tabId);
    }
  }
  if (!hasAudible) {
    save();
    return;
  }
  if (
    !changeInfo.audible &&
    (openerTab
      ? await isGroupAudible(openerTab, origTabId)
      : await isGroupAudible({...tab, audible: false}))
  ) {
    save();
    return;
  }

  if (changeInfo.audible) {
    if (deniedAudible.has(tabId) && tabId !== state.mediaPlaying) {
      save();
      return;
    }
    // If has not got a play message from the content script assume theres no permission.
    if (!state.media.has(tabId)) {
      // Allow the media to check its shadow dom.
      send(tabId, 'audible');
      state.otherTabs.add(tabId);
      if (hasProperty(options, 'ask'))
        chrome.permissions
          ?.addHostAccessRequest?.({tabId: tabId})
          ?.catch?.((err) =>
            console.debug('AutoPause addHostAccessRequest:', err)
          );
    }
    // Debounce unconfirmed/otherTabs audio when ignoreshort is enabled to filter notification sounds.
    if (
      hasProperty(options, 'ignoreshort') &&
      (state.otherTabs.has(tabId) || tabId !== state.mediaPlaying)
    ) {
      if (pendingAudible.has(tabId)) clearTimeout(pendingAudible.get(tabId));
      pendingAudible.set(
        tabId,
        setTimeout(() => {
          pendingAudible.delete(tabId);
          if (
            !state.ignoredTabs.has(tabId) &&
            (state.otherTabs.has(tabId) || state.media.has(tabId))
          ) {
            onPlay(tab);
          }
        }, shortMediaDebounce)
      );
    } else {
      onPlay(tab);
    }
  } else {
    // Cancel pending debounce if tab stopped being audible.
    if (pendingAudible.has(tabId)) {
      clearTimeout(pendingAudible.get(tabId));
      pendingAudible.delete(tabId);
    }
    state.otherTabs.delete(tabId);
    onPause(tabId);
  }
  save();
});

function denyPlay(tab, userActivation = false, wasPaused = false) {
  // Security: Logic used to determine if videos are not allowed to play.
  if (state.locked) return true;
  if (userActivation) return false;
  if (tab.id === state.mediaPlaying) return false;
  if (wasPaused) return true;
  if (tab.id === state.activeTab) return false;
  if (tab.id === state.lastPlaying) return false;
  if (hasProperty(options, 'allowactive') && tab.active) return false;
  return true;
}

async function denyPause(id, exclude, skipLast, allowbg, auto) {
  // Security: Logic used to determine if the extension is not allowed to pause automatically.
  if (state.locked) return false;
  if (id === exclude) return true;
  if (allowbg && state.backgroundaudio.has(id)) return true;
  if (skipLast && id === state.lastPlaying) return true;
  if (hasProperty(options, 'allowactive') && auto) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab.active) return true;
    } catch (err) {
      if (!/No tab with id/i.test(err?.message || '')) {
        console.warn('AutoPause denyPause:', err);
      }
      return true;
    }
  }
  return false;
}

async function pauseAll() {
  // Pause all media on a users request
  await pauseOther(false, false, false, false);
}

async function pauseOther(
  exclude = false,
  skipLast = true,
  allowbg = false,
  auto = true
) {
  state.media.forEach(async (id) => {
    // Only for tabs that have had media.
    if (await denyPause(id, exclude, skipLast, allowbg, auto)) return;
    return pause(id);
  });
  // Expand scope of pause to otherTabs if discarding is enabled.
  if (
    hasProperty(options, 'nopermission') &&
    !hasProperty(options, 'ignoreother')
  ) {
    state.otherTabs.forEach(async (id) => {
      if (await denyPause(id, exclude, skipLast, allowbg, auto)) return;
      pause(id);
    });
  }
}

async function Broadcast(message) {
  state.media.forEach((id) => {
    send(id, message);
  });
}

async function send(id, message, body = '') {
  const pipIds = getDocPiPChildIds(id);
  const sendOne = async (tabId) => {
    try {
      return await chrome.tabs.sendMessage(tabId, {type: message, body: body});
    } catch (err) {
      if (
        !/Receiving end does not exist|Could not establish connection|No tab with id|message channel closed|message port closed/i.test(
          err?.message || ''
        )
      ) {
        console.warn('AutoPause send:', message, err);
      }
    }
  };
  if (pipIds.length === 0) return sendOne(id);
  const responses = await Promise.all([sendOne(id), ...pipIds.map(sendOne)]);
  return responses.find((r) => r !== undefined);
}

async function tabTest(id, test) {
  if (state.otherTabs.has(id)) return true;
  const response = await send(id, test);
  return response === 'true';
}

async function visablePopup(id) {
  return await tabTest(id, 'visablePopup');
}

async function isPlaying(id) {
  return await tabTest(id, 'isplaying');
}

function hasProperty(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// Saves options to storage
function toggleOption(o) {
  if (hasProperty(options, o)) {
    delete options[o];
  } else {
    options[o] = true;
  }
  return new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        options
      },
      function (result) {
        if (chrome.runtime.lastError) {
          console.warn(
            'AutoPause toggleOption:',
            chrome.runtime.lastError.message
          );
        }
        resolve(result);
      }
    );
  });
}

function wildcardMatch(pattern, text) {
  const parts = pattern.split('*');
  if (parts.length === 1) return text === pattern;
  if (!text.startsWith(parts[0])) return false;
  if (!text.endsWith(parts[parts.length - 1])) return false;
  let pos = parts[0].length;
  const end = text.length - parts[parts.length - 1].length;
  if (pos > end) return false;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === '') continue;
    const idx = text.indexOf(part, pos);
    if (idx === -1 || idx + part.length > end) return false;
    pos = idx + part.length;
  }
  return true;
}

function matchesPattern(pattern, url) {
  if (pattern === '<all_urls>') {
    return /^(https?|file|ftp):\/\//.test(url);
  }
  const match = /^(https?|file|ftp|\*):\/\/([^/]*?)(\/.*)$/.exec(pattern);
  if (!match) return false;
  const [, patternScheme, patternHost, patternPath] = match;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const urlScheme = parsed.protocol.slice(0, -1);
  if (patternScheme === '*') {
    if (urlScheme !== 'http' && urlScheme !== 'https') return false;
  } else if (urlScheme !== patternScheme) {
    return false;
  }

  if (patternScheme !== 'file') {
    if (!patternHost) return false;
    const urlHost = parsed.hostname.toLowerCase();
    const targetHost = patternHost.toLowerCase();
    if (targetHost === '*') {
      // Matches any host.
    } else if (targetHost.startsWith('*.')) {
      const baseHost = targetHost.slice(2);
      if (
        !baseHost ||
        (urlHost !== baseHost && !urlHost.endsWith('.' + baseHost))
      ) {
        return false;
      }
    } else if (urlHost !== targetHost) {
      return false;
    }
  }

  return wildcardMatch(patternPath, parsed.pathname + parsed.search);
}

function isUrlExcluded(url, extra = []) {
  return exclude.concat(extra).some((pattern) => matchesPattern(pattern, url));
}

let scriptUpdateQueue = Promise.resolve();

function updateContentScripts() {
  const run = async () => {
    await initializationCompletePromise;
    const p = await chrome.permissions.getAll();
    await chrome.scripting.unregisterContentScripts();
    if (!p.origins || p.origins.length < 1) return;
    await chrome.scripting.registerContentScripts([
      {
        id: 'ContentScript',
        js: ['ContentScript.js'],
        matches: p.origins,
        excludeMatches: exclude.concat(unsupportedScripts),
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: 'document_start'
      },
      {
        id: 'WindowScript',
        js: ['WindowScript.js'],
        matches: p.origins,
        excludeMatches: exclude
          .concat(unsupportedScripts)
          .concat(unsupportedWindowScripts),
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: 'document_start',
        world: 'MAIN'
      }
    ]);
  };
  scriptUpdateQueue = scriptUpdateQueue.then(run, run);
  return scriptUpdateQueue;
}

async function updateExtensionScripts() {
  await initializationCompletePromise;
  await updateContentScripts();
  const tabs = await chrome.tabs.query({});
  tabs.forEach(async (tab) => {
    if (!tab.url || !tab.id) return;
    chrome.tabs
      .sendMessage(tab.id, {type: 'hi ya!'}, {frameId: 0})
      .catch(async () => {
        if (isUrlExcluded(tab.url, unsupportedScripts)) return;
        try {
          await chrome.scripting.executeScript({
            target: {
              tabId: tab.id,
              allFrames: true
            },
            files: ['ContentScript.js'],
            injectImmediately: true
          });
          if (!isUrlExcluded(tab.url, unsupportedWindowScripts)) {
            await chrome.scripting.executeScript({
              target: {
                tabId: tab.id,
                allFrames: true
              },
              files: ['WindowScript.js'],
              world: 'MAIN',
              injectImmediately: true
            });
          }
          send(tab.id, 'new');
        } catch (err) {
          console.debug('AutoPause executeScript:', err);
        }
      });
  });
}

async function checkIdle(userState) {
  await initializationCompletePromise;
  if (userState === 'locked') {
    if (!hasProperty(options, 'checkidle')) return;
    // Security: While locked no media should be playing and state.locked should stay true.
    if (!state.locked) state.resumeOnUnlock = state.mediaPlaying !== null;
    state.locked = true;
    state.mediaPlaying = null;
    // Pause everything
    pauseAll();
  } else if (state.locked) {
    const shouldResume = state.resumeOnUnlock;
    state.locked = false;
    state.resumeOnUnlock = false;
    if (shouldResume && hasProperty(options, 'checkidle')) {
      autoResume(null);
    }
  }
  save();
}

if (chrome.idle) {
  chrome.idle.onStateChanged.addListener(checkIdle);
}

chrome.permissions.onAdded.addListener(updateExtensionScripts);
chrome.permissions.onRemoved.addListener(updateContentScripts);
