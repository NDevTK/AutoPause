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

  if (docPiP)
    docPiP.addEventListener('enter', (event) => {
      if (event.isTrusted && event instanceof DocumentPictureInPictureEvent) {
        // For the top documentPictureInPicture window we are sharing the opener tab audible value
        addListener(event.window);
        event.window.addEventListener('focus', (e) => {
          if (e.isTrusted) send('tabFocus');
        });
      }
    });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  function onPlay(e) {
    if (isPaused(e)) return;
    let data = Elements.get(e);
    if (!data) return;
    clearTimeout(data.pauseTimer);
    if (isMuted(e)) {
      send('playMuted');
      return;
    }
    // If duration is unknown, wait for metadata before reporting to background.
    // This lets the background correctly identify short media (e.g. notification sounds).
    if (isNaN(e.duration)) {
      if (data.pendingDuration) return;
      data.pendingDuration = true;
      const sendOnce = () => {
        if (!data.pendingDuration) return;
        data.pendingDuration = false;
        clearTimeout(data.durationTimer);
        e.removeEventListener('durationchange', onDurationChange);
        if (!data.controller.signal.aborted && !isPaused(e) && !isMuted(e)) {
          send('play', data.id, e.duration);
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
    send('play', data.id, e.duration);
  }

  function validMedia(e) {
    try {
      //  documentPictureInPicture window.top media is tracked by the opener
      if (
        opener &&
        typeof DocumentPictureInPicture === 'function' &&
        opener.documentPictureInPicture instanceof
          opener.DocumentPictureInPicture &&
        opener.documentPictureInPicture.window === window
      )
        return false;
    } catch {}

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
      } else if (el.volume > 0) {
        data.volumeZeroed = false;
      }
    }
    clearTimeout(data.muteTimer);
    if (!isPaused(el)) {
      if (isMuted(el)) {
        data.muteTimer = setTimeout(() => {
          if (!data.controller.signal.aborted) onPlay(el);
        }, 200);
      } else {
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
          clearTimeout(Elements.get(el)?.pauseTimer);
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
    const data = {id: mediaID, lastMuted: src.muted, controller};
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

    src.addEventListener(
      'pause',
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

    src.addEventListener(
      'abort',
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

  addListener(window);

  window.addEventListener(
    'autoPauseMedia',
    (event) => {
      if (!(event instanceof FocusEvent)) return;
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
    },
    {
      capture: true
    }
  );

  function onPause(src, controller) {
    const data = Elements.get(src);
    if (!data || controller.signal.aborted) return;
    clearTimeout(data.pauseTimer);
    data.pauseTimer = setTimeout(() => {
      if (controller.signal.aborted) return;
      if (validMedia(src) && src.paused) {
        controller.abort();
        normalPlayback(src);
        Elements.delete(src);
        // Check if all elements have paused.
        if (!isPlaying()) {
          send('pause');
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
      src.playbackRate = data.wasPlaybackRate;
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
    if (!e.muted && e.volume > 0) {
      data.wasVolume = e.volume;
      data.volumeZeroed = true;
      e.volume = 0;
    }
    Elements.set(e, data);
  }

  async function pause() {
    if (docPiP && docPiP.window) checkShadow(docPiP.window.document, false);
    Elements.forEach((data, e) => {
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
    [...DOM.querySelectorAll('*')].map((e) => {
      let shadowDOM = shadow(e);
      if (shadowDOM !== null) {
        checkShadow(shadowDOM, notify);
        addListener(shadowDOM);
        [...shadowDOM.querySelectorAll('*')].map((e) => {
          if (e.paused === false && !isPaused(e)) {
            if (validMedia(e)) {
              addMedia(e);
              if (notify) onPlay(e);
            }
          }
        });
      }
    });
  }

  function checkDOM() {
    for (const e of document.querySelectorAll('*')) {
      if (e.paused === false && !isPaused(e)) {
        if (validMedia(e)) {
          addMedia(e);
          onPlay(e);
        }
      }
    }
  }

  function send(message, body = '', duration) {
    const msg = {
      type: message,
      body: body,
      userActivation: navigator.userActivation.isActive
    };
    if (duration !== undefined) msg.duration = duration;
    chrome.runtime.sendMessage(msg);
  }

  window.addEventListener(
    'pagehide',
    (event) => {
      if (event.isTrusted) send('pause');
    },
    {
      passive: true
    }
  );

  function visablePopup() {
    if (docPiP && docPiP.window !== null) {
      return true;
    }
    return (
      document.visibilityState !== 'hidden' ||
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
      if (event.isTrusted) checkVisibility();
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
