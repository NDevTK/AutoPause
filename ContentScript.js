/* global chrome */
(function () {
  'use strict';

  const injected = Symbol.for('autoPauseContentScript');
  if (globalThis[injected]) return;
  globalThis[injected] = true;

  const Targets = new WeakSet();
  const HandledEvents = new WeakSet();

  const Elements = new Map();

  const docPiP =
    typeof DocumentPictureInPicture === 'function' &&
    window.documentPictureInPicture instanceof DocumentPictureInPicture
      ? window.documentPictureInPicture
      : null;

  const getPictureInPictureElement = Object.getOwnPropertyDescriptor(
    Document.prototype,
    'pictureInPictureElement'
  )?.get;

  const getVisibilityState = Object.getOwnPropertyDescriptor(
    Document.prototype,
    'visibilityState'
  )?.get;

  const getNodeType = Object.getOwnPropertyDescriptor(
    Node.prototype,
    'nodeType'
  )?.get;

  const docQuerySelectorAll = Document.prototype.querySelectorAll;
  const fragQuerySelectorAll = DocumentFragment.prototype.querySelectorAll;

  function queryAll(root, selector) {
    try {
      const nodeType = getNodeType ? getNodeType.call(root) : root.nodeType;
      if (nodeType === 9 && docQuerySelectorAll) {
        return docQuerySelectorAll.call(root, selector);
      }
      if (nodeType === 11 && fragQuerySelectorAll) {
        return fragQuerySelectorAll.call(root, selector);
      }
      return root.querySelectorAll(selector);
    } catch {
      return [];
    }
  }

  const getMediaPaused = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'paused'
  )?.get;

  const getOpenOrClosedShadowRoot =
    typeof chrome?.dom?.openOrClosedShadowRoot === 'function'
      ? (e) => chrome.dom.openOrClosedShadowRoot(e)
      : (() => {
          const getter = Object.getOwnPropertyDescriptor(
            Element.prototype,
            'openOrClosedShadowRoot'
          )?.get;
          return getter ? (e) => getter.call(e) : () => null;
        })();

  const pipTokenSym = Symbol.for('autoPauseDocPiPToken');
  const pipHandshakeSym = Symbol.for('autoPauseDocPiPHandshake');

  if (window === window.top) {
    window[pipHandshakeSym] = (token) => {
      if (typeof token === 'string' && isDocPiPChild()) {
        delete window[pipTokenSym];
        send('docPiPChild', token);
      }
    };
    if (typeof window[pipTokenSym] === 'string' && isDocPiPChild()) {
      const token = window[pipTokenSym];
      delete window[pipTokenSym];
      send('docPiPChild', token);
    }
  }

  function attachDocPiP(pipWin) {
    if (!pipWin || Targets.has(pipWin)) return;
    // For the top documentPictureInPicture window we are sharing the opener tab audible value
    const pipDoc = pipWin.document;
    addListener(pipWin);
    pipWin.addEventListener('autoPauseMedia', onAutoPauseMedia, {
      capture: true
    });
    try {
      const token = crypto.randomUUID();
      send('docPiPOpen', token);
      if (typeof pipWin[pipHandshakeSym] === 'function') {
        pipWin[pipHandshakeSym](token);
      } else {
        pipWin[pipTokenSym] = token;
      }
    } catch {}
    pipWin.addEventListener('focus', (e) => {
      if (e.isTrusted) send('tabFocus');
    });
    pipWin.addEventListener(
      'pagehide',
      (e) => {
        if (!e.isTrusted) return;
        setTimeout(() => {
          let removed = false;
          Elements.forEach((data, el) => {
            if (el.ownerDocument === pipDoc) {
              data.controller.abort();
              normalPlayback(el);
              Elements.delete(el);
              removed = true;
            }
          });
          if (removed && !isPlaying()) {
            const hasUnpaused = [...Elements.keys()].some((el) => !el.paused);
            send(hasUnpaused ? 'playMuted' : 'pause');
          } else {
            checkVisibility();
          }
        }, 200);
      },
      {once: true, passive: true}
    );
    checkShadow(pipDoc);
    checkDOM(pipDoc);
  }

  if (docPiP) {
    docPiP.addEventListener('enter', (event) => {
      if (event.isTrusted && event instanceof DocumentPictureInPictureEvent) {
        attachDocPiP(event.window);
      }
    });
    if (docPiP.window) {
      attachDocPiP(docPiP.window);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (isDocPiPChild()) return;
    switch (message.type) {
      case 'visablePopup':
        if (!visablePopup()) break;
        sendResponse('true');
        break;
      case 'toggleFastPlayback':
        toggleRate();
        break;
      case 'Rewind':
        Rewind();
        break;
      case 'allowplayback':
        resume(false);
        break;
      case 'next':
        next();
        break;
      case 'previous':
        previous();
        break;
      case 'pause':
        pause();
        break;
      case 'play':
        // When there media already playing tell the background script.
        if (isPlaying()) send('play');
        resume(true);
        break;
      case 'normalPlayback':
        Elements.forEach((data, e) => {
          if (
            data.wasPlaying &&
            ((data.rateZeroed && !isPaused(e)) ||
              (data.playRequested && !e.paused))
          ) {
            normalPlayback(e);
          }
        });
        break;
      case 'audible':
        checkShadow();
        checkDOM();
        break;
      case 'hidden':
        checkVisibility();
        break;
      case 'isplaying':
        if (!isPlaying()) break;
        sendResponse('true');
        break;
      case 'pauseOther':
        pauseOther(message.body);
        break;
      case 'new':
        checkShadow();
        checkDOM();
        break;
    }
  });

  function isPlaying() {
    checkShadow();
    const audibleElements = [...Elements].filter((e, data) => !isMuted(e[0]));
    return audibleElements.length !== 0;
  }

  function isPaused(e) {
    return e.paused || e.playbackRate === 0;
  }

  function next() {
    Elements.forEach((data, e) => {
      if (isPaused(e)) return;
      if (Number.isFinite(e.duration)) e.currentTime = e.duration;
    });
  }

  function previous() {
    Elements.forEach((data, e) => {
      if (isPaused(e)) return;
      // Go to start of media
      e.currentTime = 0;
    });
  }

  // Controlled by global fast forward shortcut
  function toggleRate() {
    Elements.forEach((data, e) => {
      if (isPaused(e)) return;
      if (e.playbackRate > 1) {
        e.playbackRate = 1;
      } else {
        e.playbackRate = 2;
      }
    });
  }

  function pauseOther(id) {
    Elements.forEach((data, e) => {
      if (e.paused || isMuted(e)) return;
      if (data.id !== id) e.pause();
    });
  }

  // Controlled by global rewind shortcut
  function Rewind() {
    Elements.forEach((data, e) => {
      if (isPaused(e)) return;
      e.currentTime -= 30;
    });
  }

  function canNotifyPlay(e, data) {
    return (
      !isPaused(e) ||
      (data?.wasPlaying === true && data.playRequested === true && !e.paused)
    );
  }

  function onPlay(e) {
    let data = Elements.get(e);
    if (!data || !canNotifyPlay(e, data)) return;
    clearTimeout(data.pauseTimer);
    if (isMuted(e)) {
      clearTimeout(data.durationTimer);
      data.pendingDuration = false;
      data.playRequested = false;
      data.reportedMuted = true;
      send('playMuted');
      return;
    }
    // If duration is unknown, wait for metadata before reporting to background.
    // This lets the background correctly identify short media (e.g. notification sounds).
    if (isNaN(e.duration)) {
      if (data.pendingDuration) return;
      data.pendingDuration = true;
      const hadActivation = Boolean(navigator.userActivation?.isActive);
      const sendOnce = () => {
        if (!data.pendingDuration) return;
        data.pendingDuration = false;
        clearTimeout(data.durationTimer);
        e.removeEventListener('durationchange', onDurationChange);
        if (
          !data.controller.signal.aborted &&
          canNotifyPlay(e, data) &&
          !isMuted(e)
        ) {
          data.reportedMuted = false;
          send(
            'play',
            data.id,
            e.duration,
            data.wasPlaying === true,
            hadActivation || Boolean(navigator.userActivation?.isActive)
          );
        }
      };
      const onDurationChange = (event) => {
        if (event.isTrusted) sendOnce();
      };
      e.addEventListener('durationchange', onDurationChange, {
        signal: data.controller.signal
      });
      data.durationTimer = setTimeout(sendOnce, 500);
      return;
    }
    clearTimeout(data.durationTimer);
    data.pendingDuration = false;
    data.reportedMuted = false;
    send('play', data.id, e.duration, data.wasPlaying === true);
  }

  function isDocPiPChild() {
    try {
      return Boolean(
        opener &&
        typeof DocumentPictureInPicture === 'function' &&
        opener.documentPictureInPicture instanceof
          opener.DocumentPictureInPicture &&
        opener.documentPictureInPicture.window === window
      );
    } catch {
      return false;
    }
  }

  function validMedia(e) {
    //  documentPictureInPicture window.top media is tracked by the opener
    if (isDocPiPChild()) return false;

    if (!e || typeof getMediaPaused !== 'function') return false;
    try {
      return typeof getMediaPaused.call(e) === 'boolean';
    } catch {
      return false;
    }
  }

  function onVolumeChange(event) {
    if (!event.isTrusted || HandledEvents.has(event)) return;
    const el = event.target;
    const data = Elements.get(el);
    if (!data) return;
    HandledEvents.add(event);
    const mutedChanged = el.muted !== data.lastMuted;
    data.lastMuted = el.muted;
    if (
      data.wasPlaying &&
      data.volumeZeroed &&
      el.volume === 0 &&
      !mutedChanged
    ) {
      event.stopImmediatePropagation();
      return;
    }
    if (data.wasPlaying) {
      if (
        mutedChanged &&
        !el.muted &&
        el.volume > 0 &&
        typeof el.srcObject?.getAudioTracks === 'function'
      ) {
        data.wasVolume = el.volume;
        data.volumeZeroed = true;
        el.volume = 0;
        if (navigator.userActivation?.isActive) {
          data.playRequested = true;
          clearTimeout(data.muteTimer);
          onPlay(el);
        }
        return;
      } else if (el.volume > 0) {
        if (!data.rateZeroed && data.volumeZeroed && !el.muted) {
          data.playRequested = true;
        }
        data.volumeZeroed = false;
      }
      if (
        mutedChanged &&
        !el.muted &&
        data.rateZeroed &&
        !el.paused &&
        !isMuted(el) &&
        navigator.userActivation?.isActive
      ) {
        data.playRequested = true;
      }
    }
    clearTimeout(data.muteTimer);
    if (canNotifyPlay(el, data) && !data.volumeZeroed) {
      if (isMuted(el)) {
        if (!data.reportedMuted) {
          data.muteTimer = setTimeout(() => {
            if (!data.controller.signal.aborted && isMuted(el)) onPlay(el);
          }, 200);
        }
      } else if (data.reportedMuted || data.wasPlaying) {
        onPlay(el);
      }
    }
  }

  // Dont tell the media please
  function onRateChange(event) {
    if (!event.isTrusted || HandledEvents.has(event)) return;
    const el = event.target;
    const data = Elements.get(el);
    if (!data) return;
    HandledEvents.add(event);
    if (el.playbackRate === 0 && data.wasPlaying) {
      event.stopImmediatePropagation();
      return;
    }
    if (!isPaused(el)) {
      onPlay(el);
    }
  }

  function addListener(src) {
    if (Targets.has(src)) return;
    Targets.add(src);
    // On media play event
    src.addEventListener(
      'play',
      function (event) {
        if (!event.isTrusted || HandledEvents.has(event)) return;
        HandledEvents.add(event);
        const el = event.target;
        if (validMedia(el)) {
          addMedia(el);
          const data = Elements.get(el);
          clearTimeout(data?.pauseTimer);
          if (
            data?.wasPlaying &&
            !el.paused &&
            !isMuted(el) &&
            ((data.rateZeroed && el.playbackRate === 0) ||
              (!data.rateZeroed && data.volumeZeroed))
          ) {
            data.playRequested = true;
          }
          onPlay(el);
        }
      },
      {
        capture: true,
        passive: true
      }
    );
    src.addEventListener('volumechange', onVolumeChange, {capture: true});
    src.addEventListener('ratechange', onRateChange, {capture: true});
  }

  function isMuted(e) {
    if (e.muted) return true;
    const data = Elements.get(e);
    if (data?.volumeZeroed) {
      return data.wasVolume === 0;
    }
    return e.volume === 0;
  }

  function addMedia(src) {
    if (Elements.has(src)) return;

    let mediaID = '';
    try {
      mediaID = crypto.randomUUID();
    } catch {
      // On insecure website we cant have a ID :(
    }

    let controller = new AbortController();
    const data = {
      id: mediaID,
      lastMuted: src.muted,
      reportedMuted: false,
      controller
    };
    Elements.set(src, data);

    controller.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(data.pauseTimer);
        clearTimeout(data.muteTimer);
        clearTimeout(data.durationTimer);
        data.pendingDuration = false;
      },
      {once: true}
    );

    if (!Targets.has(src)) {
      src.addEventListener('volumechange', onVolumeChange, {
        signal: controller.signal,
        capture: true
      });
      src.addEventListener('ratechange', onRateChange, {
        signal: controller.signal,
        capture: true
      });
    }

    for (const type of ['pause', 'abort', 'emptied']) {
      src.addEventListener(
        type,
        (event) => {
          if (!event.isTrusted) return;
          onPause(event.target, controller);
        },
        {
          signal: controller.signal,
          capture: true,
          passive: true
        }
      );
    }

    src.addEventListener(
      'leavepictureinpicture',
      (event) => {
        if (event.isTrusted) checkVisibility();
      },
      {
        signal: controller.signal,
        passive: true
      }
    );
  }

  addListener(window);

  function onAutoPauseMedia(event) {
    const FocusEventCtor = event.currentTarget?.FocusEvent || FocusEvent;
    if (!(event instanceof FocusEventCtor)) return;
    if (isDocPiPChild()) {
      event.stopPropagation();
      return;
    }
    event.stopImmediatePropagation();
    const target = event.relatedTarget;
    if (!target) return;
    if (validMedia(target)) {
      addListener(target);
    } else {
      const shadowDOM = shadow(target);
      if (shadowDOM !== null) {
        addListener(shadowDOM);
        checkShadow(shadowDOM);
      }
    }
  }

  window.addEventListener('autoPauseMedia', onAutoPauseMedia, {
    capture: true
  });

  function onPause(src, controller) {
    const data = Elements.get(src);
    if (!data || controller.signal.aborted) return;
    data.playRequested = false;
    clearTimeout(data.durationTimer);
    data.pendingDuration = false;
    clearTimeout(data.pauseTimer);
    data.pauseTimer = setTimeout(() => {
      if (controller.signal.aborted) return;
      if (validMedia(src) && src.paused) {
        controller.abort();
        normalPlayback(src);
        Elements.delete(src);
        // Check if all elements have paused.
        if (!isPlaying()) {
          const hasUnpaused = [...Elements.keys()].some((el) => !el.paused);
          send(hasUnpaused ? 'playMuted' : 'pause');
        }
      }
    }, 200);
  }

  function normalPlayback(src) {
    let data = Elements.has(src) ? Elements.get(src) : {};
    if (data.wasPlaying) {
      if (data.volumeZeroed && src.volume === 0 && data.wasVolume > 0) {
        src.volume = data.wasVolume;
      }
      data.volumeZeroed = false;
      if (src.playbackRate === 0) src.playbackRate = data.wasPlaybackRate;
      data.rateZeroed = false;
      data.playRequested = false;
      data.wasPlaying = false;
    }
  }

  function pauseElement(e, data) {
    // If media attempts to play when it should be paused dont change its old values.
    if (!data.wasPlaying) {
      data.wasVolume = e.volume;
      data.wasPlaybackRate = e.playbackRate;
    }
    // Rate and volume change events will stopImmediatePropagation.
    data.wasPlaying = true;
    e.playbackRate = 0;
    data.rateZeroed = e.playbackRate === 0;
    if (!e.muted && e.volume > 0) {
      data.wasVolume = e.volume;
      data.volumeZeroed = true;
      e.volume = 0;
    }
    Elements.set(e, data);
  }

  async function pause() {
    checkShadow(document, false);
    Elements.forEach((data, e) => {
      data.playRequested = false;
      if (isPaused(e)) return;
      pauseElement(e, data);
    });
  }

  async function resume(shouldPlay) {
    Elements.forEach((data, e) => {
      if (!data.wasPlaying) return;
      // Pause foreground media normaly
      if (shouldPlay === false) e.pause();
      normalPlayback(e);
    });
  }

  function checkShadow(DOM = document, notify = true) {
    // If we are checking this document also check documentPictureInPicture
    if (DOM === document && docPiP && docPiP.window)
      checkShadow(docPiP.window.document, notify);
    for (const e of queryAll(DOM, '*')) {
      let shadowDOM = shadow(e);
      if (shadowDOM !== null) {
        checkShadow(shadowDOM, notify);
        addListener(shadowDOM);
        for (const media of queryAll(shadowDOM, 'audio, video')) {
          if (media.paused === false && !isPaused(media)) {
            if (!Elements.has(media) && validMedia(media)) {
              addMedia(media);
              if (notify) onPlay(media);
            }
          }
        }
      }
    }
  }

  function checkDOM(DOM = document) {
    if (DOM === document && docPiP && docPiP.window)
      checkDOM(docPiP.window.document);
    for (const e of queryAll(DOM, 'audio, video')) {
      if (e.paused === false && !isPaused(e)) {
        if (!Elements.has(e) && validMedia(e)) {
          addMedia(e);
          onPlay(e);
        }
      }
    }
  }

  function send(
    message,
    body = '',
    duration,
    wasPaused = false,
    userActivation = Boolean(navigator.userActivation?.isActive)
  ) {
    const msg = {
      type: message,
      body: body,
      userActivation: Boolean(userActivation)
    };
    if (duration !== undefined) msg.duration = duration;
    if (wasPaused) msg.wasPaused = true;
    try {
      chrome.runtime.sendMessage(msg)?.catch?.(() => {});
    } catch {}
  }

  window.addEventListener(
    'pagehide',
    (event) => {
      if (!event.isTrusted) return;
      const hadElements = Elements.size > 0;
      if (hadElements) {
        Elements.forEach((data, e) => {
          data.controller.abort();
          normalPlayback(e);
        });
        Elements.clear();
      }
      if (!isDocPiPChild() && (window === window.top || hadElements)) {
        send('pause');
      }
    },
    {
      passive: true
    }
  );

  function visablePopup() {
    if (docPiP && docPiP.window !== null) {
      return true;
    }
    const visibilityState = getVisibilityState
      ? getVisibilityState.call(document)
      : document.visibilityState;
    return (
      visibilityState !== 'hidden' ||
      Boolean(getPictureInPictureElement?.call(document))
    );
  }

  function checkVisibility() {
    if (!visablePopup()) {
      checkShadow();
      send('hidden');
    }
  }

  window.addEventListener(
    'visibilitychange',
    (event) => {
      if (event.isTrusted && !isDocPiPChild()) checkVisibility();
    },
    {
      capture: true,
      passive: true
    }
  );

  function hasProperty(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function shadow(e) {
    try {
      return getOpenOrClosedShadowRoot(e) ?? null;
    } catch {
      return null;
    }
  }
})();
