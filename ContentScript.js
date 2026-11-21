/* global chrome */
(function () {
  'use strict';

  const injected = Symbol.for('autoPauseContentScript');
  if (globalThis[injected]) return;
  globalThis[injected] = true;

  const Targets = new WeakSet();
  const HandledPlayEvents = new WeakSet();

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
        addListener(event.window.document);
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
    if (isMuted(e)) {
      send('playMuted');
      return;
    }
    // If duration is unknown, wait for metadata before reporting to background.
    // This lets the background correctly identify short media (e.g. notification sounds).
    if (isNaN(e.duration)) {
      let sent = false;
      const sendOnce = () => {
        if (sent) return;
        sent = true;
        e.removeEventListener('durationchange', onDurationChange);
        if (!isPaused(e) && !isMuted(e)) {
          send('play', data.id, e.duration);
        }
      };
      const onDurationChange = (event) => {
        if (event.isTrusted) sendOnce();
      };
      e.addEventListener('durationchange', onDurationChange);
      setTimeout(sendOnce, 500);
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

  function addListener(src) {
    if (Targets.has(src)) return;
    Targets.add(src);
    // On media play event
    src.addEventListener(
      'play',
      function (event) {
        if (!event.isTrusted || HandledPlayEvents.has(event)) return;
        HandledPlayEvents.add(event);
        if (validMedia(event.srcElement)) {
          addMedia(event.srcElement);
          onPlay(event.srcElement);
        }
      },
      {
        capture: true,
        passive: true
      }
    );
  }

  function isMuted(e) {
    if (e.muted) return true;
    if (Elements.has(e)) {
      let data = Elements.get(e);
      if (data.wasPlaying) {
        return data.wasVolume === 0;
      }
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

    Elements.set(src, {id: mediaID, lastMuted: src.muted});
    let controller = new AbortController();

    src.addEventListener(
      'volumechange',
      async (event) => {
        if (!event.isTrusted) return;
        if (validMedia(event.srcElement)) {
          const el = event.srcElement;
          const data = Elements.get(el);
          const mutedChanged = data && el.muted !== data.lastMuted;
          if (data) data.lastMuted = el.muted;
          if (
            data?.wasPlaying &&
            data.wasVolume > 0 &&
            el.volume === 0 &&
            !mutedChanged
          ) {
            event.stopPropagation();
            return;
          }
          if (!isPaused(el)) {
            if (isMuted(el)) await sleep(200);
            onPlay(el);
          }
        }
      },
      {
        signal: controller.signal,
        capture: true
      }
    );

    src.addEventListener(
      'pause',
      (event) => {
        if (!event.isTrusted) return;
        let src = event.srcElement;
        onPause(src, controller);
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
        onPause(event.srcElement, controller);
      },
      {
        signal: controller.signal,
        capture: true,
        passive: true
      }
    );

    // Dont tell the media please
    src.addEventListener(
      'ratechange',
      function (event) {
        if (!event.isTrusted) return;
        if (validMedia(event.srcElement)) {
          let data = Elements.has(event.srcElement)
            ? Elements.get(event.srcElement)
            : {};
          if (event.srcElement.playbackRate === 0 && data.wasPlaying) {
            event.stopPropagation();
          }
          if (!isPaused(event.srcElement)) {
            onPlay(event.srcElement);
          }
        }
      },
      {
        signal: controller.signal,
        capture: true
      }
    );
  }

  addListener(document);

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

  async function onPause(src, controller) {
    await sleep(200);
    if (validMedia(src) && src.paused) {
      controller.abort();
      normalPlayback(src);
      Elements.delete(src);
      // Check if all elements have paused.
      if (!isPlaying()) {
        send('pause');
      }
    }
  }

  function normalPlayback(src) {
    let data = Elements.has(src) ? Elements.get(src) : {};
    if (data.wasPlaying) {
      if (src.volume === 0 && data.wasVolume > 0) src.volume = data.wasVolume;
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
    // Rate and volume change events will stopPropagation.
    data.wasPlaying = true;
    e.playbackRate = 0;
    if (!e.muted) e.volume = 0;
    Elements.set(e, data);
  }

  async function pause() {
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

  function checkShadow(DOM = document) {
    // If we are checking this document also check documentPictureInPicture
    if (DOM === document && docPiP && docPiP.window)
      checkShadow(docPiP.window.document);
    [...DOM.querySelectorAll('*')].map((e) => {
      let shadowDOM = shadow(e);
      if (shadowDOM !== null) {
        checkShadow(shadowDOM);
        addListener(shadowDOM);
        [...shadowDOM.querySelectorAll('*')].map((e) => {
          if (e.paused === false && !isPaused(e)) {
            if (validMedia(e)) {
              addMedia(e);
              onPlay(e);
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
