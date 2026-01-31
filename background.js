'use strict';
/* global chrome */
var state = {};

const resumelimit = 5;
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
state.lastPlaying = null;
state.otherTabs = new Set(); // Tab IDs of media with no permission to access.
state.mutedTabs = new Set(); // Tab IDs of all muted media.
state.ignoredTabs = new Set();
state.mutedMedia = new Set(); // Tab IDs of resumable muted media.
state.legacyMedia = new Set(); // Tab IDs of old media.
state.autoPauseWindow = null;
state.locked = false;

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

async function restore() {
  let result = await chrome.storage.session.get('state');
  if (typeof result.state === 'object' && result.state !== null) {
    // Support Set();
    for (let value of setItems) {
      result.state[value] = new Set(result.state[value]);
    }
    state = result.state;
  }
  let result2 = await chrome.storage.session.get(['options', 'exclude']);
  if (typeof result2.options === 'object' && result2.options !== null) {
    options = result2.options;
  } else {
    let result3 = await chrome.storage.sync.get(['options']);
    if (typeof result3.options === 'object' && result3.options !== null) {
      options = result3.options;
      chrome.storage.session.set({options});
    }
  }

  if (Array.isArray(result2.exclude)) {
    exclude = result2.exclude;
  } else {
    let result3 = await chrome.storage.sync.get(['exclude']);
    if (Array.isArray(result3.exclude)) {
      exclude = result3.exclude;
      chrome.storage.session.set({exclude});
    }
  }
  resolveInitialization();
}

restore();

// Security: chrome.storage.sync is not safe from website content scripts.
chrome.storage.onChanged.addListener((result) => {
  // We ignore options and exclude changes here to prevent content script tampering.
  // Updates are handled via trusted messages from the options page.
});

// On install display the options page so the user can give permissions.
chrome.runtime.onInstalled.addListener(async (details) => {
  await initializationCompletePromise;
  updateExtensionScripts();
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
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

  if (message.type === 'updateOptions') {
    // Security: Only allow options updates from extension pages.
    if (sender.url && sender.url.startsWith(chrome.runtime.getURL(''))) {
      if (typeof message.options === 'object' && message.options !== null) {
        options = message.options;
        chrome.storage.session.set({options});
        chrome.storage.sync.set({options});
      }
      if (Array.isArray(message.exclude)) {
        exclude = message.exclude;
        chrome.storage.session.set({exclude});
        chrome.storage.sync.set({exclude});
        updateContentScripts();
      }
    }
    return;
  }

  // Security: Messages are from untrusted website content scripts.
  if (sender.tab &&
    state.autoPauseWindow !== null &&
    state.autoPauseWindow !== sender.tab.windowId
  )
    return;

  if (!sender.tab) return;
  state.otherTabs.delete(sender.tab.id);
  if (!hasProperty(sender, 'tab') || state.ignoredTabs.has(sender.tab.id))
    return;
  switch (message.type) {
    case 'hidden':
      if (await visablePopup(sender.tab.id)) break;
      if (state.mutedTabs.has(sender.tab.id)) {
        if (
          hasProperty(options, 'muteonpause') &&
          state.mutedMedia.has(sender.tab.id)
        ) {
          state.media.add(sender.tab.id);
        }
        // Pause hidden muted tabs.
        pause(sender.tab.id);
      }
      break;
    case 'play':
      if (sender.tab.mutedInfo.muted) {
        state.mutedMedia.add(sender.tab.id);
        onMute(sender.tab.id);
      } else {
        state.mutedMedia.delete(sender.tab.id);
        state.media.add(sender.tab.id);
        onPlay(sender.tab, message.body, message.userActivation);
      }
      break;
    case 'playMuted':
      if (await isPlaying(sender.tab.id)) break;
      state.mutedMedia.delete(sender.tab.id);
      onMute(sender.tab.id);
      break;
    case 'pause':
      if (await isPlaying(sender.tab.id)) break;
      remove(sender.tab.id);
      break;
    case 'tabFocus':
      // Security: Verify the action is actually a real tab activation (documentPictureInPicture)
      tabChange(sender.tab);
      break;
  }
  save();
});

chrome.tabs.onReplaced.addListener(async (newId, oldId) => {
  await initializationCompletePromise;
  if (state.ignoredTabs.has(oldId)) {
    state.ignoredTabs.add(newId);
    state.ignoredTabs.delete(oldId);
  }
  remove(oldId);
  save();
});

function onPlay(tab, id = '', userActivation = false) {
  // Security: userActivation is from untrusted website content scripts however the isolated world should prevent attacks.
  if (state.autoPauseWindow !== null && state.autoPauseWindow !== tab.windowId)
    return;

  if (hasProperty(options, 'ignoreother') && state.otherTabs.has(tab.id))
    return;

  if (hasProperty(options, 'multipletabs') && tab.id !== state.activeTab)
    return;
  // Dont allow a diffrent tab to hijack active media.
  if (denyPlay(tab, userActivation)) {
    return pause(tab.id);
  }
  state.mediaPlaying = tab.id;

  if (hasProperty(options, 'muteonpause'))
    chrome.tabs.update(tab.id, {muted: false});

  if (hasProperty(options, 'permediapause') && id.length === 36)
    send(tab.id, 'pauseOther', id);

  if (tab.id == state.activeTab) state.lastPlaying = null;
  if (state.media.has(tab.id)) {
    state.legacyMedia.delete(tab.id);
    state.mutedTabs.delete(tab.id);
    // Make tab top priority.
    state.media.delete(tab.id);
    state.media.add(tab.id);
    if (hasProperty(options, 'resumelimit') && state.media.size > resumelimit) {
      state.legacyMedia.add(
        [...state.media][state.media.size - 1 - resumelimit]
      );
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
  }
  save();
}

async function tabChange(tab) {
  if (state.ignoredTabs.has(tab.id)) return;

  if (state.autoPauseWindow !== null && state.autoPauseWindow !== tab.windowId)
    return;

  state.activeTab = tab.id;
  save();

  if (hasProperty(options, 'ignoretabchange')) return;

  if (hasProperty(options, 'pauseoninactive')) {
    // Pause all except active, last playing, backgroundaudio tab
    pauseOther(tab.id, true, true);
  }

  if (state.media.has(tab.id) || state.mutedTabs.has(tab.id)) {
    play(tab.id);
  } else if (state.otherTabs.has(tab.id)) {
    onPlay(tab);
  }
  save();
}

function getResumeTab(exclude) {
  const tabs =
    state.backgroundaudio.size > 0 ||
    hasProperty(options, 'pauseoninactive') ||
    hasProperty(options, 'noauto')
      ? state.backgroundaudio
      : state.media;

  // Prefer the active tab
  if (state.media.has(state.activeTab) && state.activeTab !== exclude) {
    return state.activeTab;
  }

  const resumableMedia = Array.from(tabs).filter(
    (id) => id !== exclude && !state.legacyMedia.has(id)
  );

  if (resumableMedia.length > 0) {
    return resumableMedia.pop();
  }
  return false;
}

// User may have mutiple windows open.
chrome.windows.onFocusChanged.addListener(async (id) => {
  await initializationCompletePromise;
  if (id === chrome.windows.WINDOW_ID_NONE) return;
  if (state.autoPauseWindow !== null && state.autoPauseWindow !== id) return;
  setTimeout(() => {
    chrome.tabs.query(
      {
        active: true,
        currentWindow: true
      },
      (tabs) => {
        if (tabs.length === 1) {
          tabChange(tabs[0]);
          save();
        }
      }
    );
  }, 200);
});

// Dont track unrelated windows
chrome.tabs.onDetached.addListener(async (id) => {
  await initializationCompletePromise;
  if (state.autoPauseWindow === null) return;
  remove(id);
  save();
});

// Handle keyboard shortcuts.
chrome.commands.onCommand.addListener(async (command) => {
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
          if (tabs.length > 0) {
            chrome.tabs.update(tabs[0].id, {
              active: true
            });
          } else if (state.media.size > 0) {
            const result = getResumeTab();
            if (result !== false) {
              chrome.tabs.update(result, {
                active: true
              });
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
      } else {
        var result = getResumeTab();
        if (result !== false) {
          // Ignore pause event due to this hotkey
          if (state.mediaPlaying === null) {
            state.mediaPlaying = result;
            play(result);
          }
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
    case 'backgroundaudio':
      // Currently only has one tab
      state.backgroundaudio.clear();
      state.backgroundaudio.add(state.activeTab);
      break;
    case 'ignoretab':
      state.ignoredTabs.add(state.activeTab);
      remove(state.activeTab);
      break;
    case 'previoustab':
      state.lastPlaying = null;
      switchMedia();
      break;
    case 'autopausewindow':
      chrome.windows.getCurrent((w) => {
        if (w.id === chrome.windows.WINDOW_ID_NONE) return;
        state.autoPauseWindow = w.id;
        save();
      });
      break;
  }
  save();
});

function pause(id, checkHidden) {
  // Security: Leaks to websites that a different tab is audible or shotcut usage, Boring DoS.
  if (hasProperty(options, 'nopermission')) {
    chrome.tabs.discard(id);
    return;
  }
  if (state.otherTabs.has(id)) return;
  if (checkHidden) {
    send(id, 'hidden');
  } else {
    if (hasProperty(options, 'muteonpause'))
      chrome.tabs.update(id, {muted: true});
    send(id, 'pause');
  }
}

function play(id, force) {
  // Security: If muteonpause is enabled need to ensure a tab is not unmuted when not wanted.
  if (hasProperty(options, 'muteonpause'))
    chrome.tabs.update(id, {muted: false});
  if (hasProperty(options, 'disableresume') && !force) {
    send(id, 'allowplayback');
  } else {
    send(id, 'play');
  }
}

function switchMedia() {
  const result = getResumeTab(state.mediaPlaying);
  state.mediaPlaying = result;
  if (result !== false) play(result);
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
    state.backgroundaudio.size === 0
  ) {
    // Resume all tabs when multipletabs is enabled.
    return Broadcast('play');
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
    tabChange(tab);
    save();
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await initializationCompletePromise;
  setTimeout(() => {
    state.ignoredTabs.delete(tabId);
    remove(tabId);
    save();
  }, 200);
});

function remove(tabId) {
  state.media.delete(tabId);
  state.mutedMedia.delete(tabId);
  state.otherTabs.delete(tabId);
  state.backgroundaudio.delete(tabId);
  state.mutedTabs.delete(tabId);
  state.legacyMedia.delete(tabId);
  onPause(tabId);
}

// Detect changes to audible status of tabs
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await initializationCompletePromise;
  if (state.autoPauseWindow !== null && state.autoPauseWindow !== tab.windowId)
    return;
  if (state.ignoredTabs.has(tabId)) return;
  if (changeInfo.discarded) {
    return remove(tabId);
  }
  if (hasProperty(changeInfo, 'mutedInfo')) {
    if (changeInfo.mutedInfo.muted && state.media.has(tabId)) {
      state.mutedMedia.add(tabId);
      onMute(tabId);
    }
    // If tab gets unmuted resume it.
    else if (!changeInfo.mutedInfo.muted && state.mutedMedia.has(tabId)) {
      state.mediaPlaying = tabId;
      play(tabId, true);
    } else if (changeInfo.mutedInfo.muted && state.otherTabs.has(tabId)) {
      state.otherTabs.delete(tabId);
      onPause(tabId);
    }
  }
  save();
  if (!hasProperty(changeInfo, 'audible')) return; // Bool that contains if audio is playing on tab.

  if (changeInfo.audible) {
    // If has not got a play message from the content script assume theres no permission.
    if (!state.media.has(tabId)) {
      // Allow the media to check its shadow dom.
      send(tabId, 'audible');
      state.otherTabs.add(tabId);
      if (hasProperty(options, 'ask'))
        chrome.permissions.addHostAccessRequest({tabId: tabId});
    }
    onPlay(tab);
  } else {
    state.otherTabs.delete(tabId);
    onPause(tabId);
  }
  save();
});

function denyPlay(tab, userActivation = false) {
  // Security: Logic used to determine if videos are not allowed to play.
  if (state.locked) return true;
  if (userActivation) return false;
  if (tab.id === state.activeTab) return false;
  if (tab.id === state.lastPlaying) return false;
  if (tab.id === state.mediaPlaying) return false;
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
    const tab = await chrome.tabs.get(id);
    if (tab.active) return true;
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
  try {
    return await chrome.tabs.sendMessage(id, {type: message, body: body});
  } catch {}
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
  chrome.storage.session.set({options});
  return new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        options
      },
      function (result) {
        resolve(result);
      }
    );
  });
}

function matchPatternToRegExp(pattern) {
  if (pattern === '<all_urls>') {
    return /^(https?|file|ftp):\/\/.*/;
  }
  const match = /^(.*):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!match) {
    console.error('Invalid pattern:', pattern);
    return /^(?!)/; // Matches nothing
  }
  const [, scheme, host, path] = match;
  const specialChars = /[\\[\]\(\)\{\}\^\$\+\.\?]/g;
  let re = '^';
  if (scheme === '*') {
    re += '(https?|ftp)';
  } else {
    re += scheme.replace(specialChars, '\\$&');
  }
  re += ':\\/\\/';
  if (host === '*') {
    re += '[^/]+';
  } else if (host.startsWith('*.')) {
    re += '([^/]+\\.)?';
    re += host.substring(2).replace(specialChars, '\\$&');
  } else {
    re += host.replace(specialChars, '\\$&');
  }
  re += path.replace(specialChars, '\\$&').replace(/\*/g, '.*');
  re += '$';
  return new RegExp(re);
}

function isUrlExcluded(url, extra = []) {
  return exclude.concat(extra).some((pattern) => {
    try {
      return matchPatternToRegExp(pattern).test(url);
    } catch (e) {
      console.error('Error matching pattern:', pattern, e);
      return false;
    }
  });
}

async function updateContentScripts() {
  await initializationCompletePromise;
  chrome.permissions.getAll(async (p) => {
    await chrome.scripting.unregisterContentScripts();
    if (p.origins.length < 1) return;
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
        runAt: 'document_start',
        world: 'MAIN'
      }
    ]);
  });
}

async function updateExtensionScripts() {
  await initializationCompletePromise;
  await updateContentScripts();
  const tabs = await chrome.tabs.query({});
  tabs.forEach(async (tab) => {
    if (!tab.url || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, {type: 'hi ya!'}).catch(async () => {
      if (isUrlExcluded(tab.url, unsupportedScripts)) return;
      await chrome.scripting.executeScript({
        target: {
          tabId: tab.id,
          allFrames: true
        },
        files: ['ContentScript.js'],
        injectImmediately: true
      });
      if (isUrlExcluded(tab.url, unsupportedWindowScripts)) return;
      await chrome.scripting.executeScript({
        target: {
          tabId: tab.id,
          allFrames: true
        },
        files: ['WindowScript.js'],
        world: 'MAIN',
        injectImmediately: true
      });
      send(tab.id, 'new');
    });
  });
}

async function checkIdle(userState) {
  await initializationCompletePromise;
  if (!hasProperty(options, 'checkidle')) return;
  if (userState === 'locked') {
    // Security: While locked no media should be playing and state.locked should stay true.
    state.locked = true;
    // Pause everything
    pauseAll();
  } else if (state.locked) {
    state.locked = false;
    const tabId = getResumeTab();
    if (tabId !== false) play(tabId);
  }
  save();
}

if (chrome.idle) {
  chrome.idle.onStateChanged.addListener(checkIdle);
}

chrome.permissions.onAdded.addListener(updateExtensionScripts);
chrome.permissions.onRemoved.addListener(updateContentScripts);
