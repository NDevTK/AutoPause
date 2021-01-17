'use strict';
/* global chrome */

// Script should only run once
if (tabPause === undefined) {
  var tabPause = false;
  var Elements = new Set();
}

chrome.runtime.onMessage.addListener(message => {
  switch (message) {
    case 'toggleFastPlayback':
      toggleRate();
      break
    case 'pause':
      pause();
      break
    case 'play':
      resume(true);
      break
    case 'allowplayback':
      resume(false);
      break
  }
});

window.addEventListener('beforeunload', () => {
  Elements.clear();
  chrome.runtime.sendMessage('pause');
}, { passive: true });

window.addEventListener('DOMContentLoaded', () => {
  // Adds content to DOM needed because of isolation
  injectScript('WindowScript.js');
}, { passive: true });

// Controlled by global fast forward shortcut
function toggleRate() {
  Elements.forEach(e => {
    if (e.paused || e.playbackRate === 0 || e.wasPlaying) return;
    if (e.wasPlaybackRate && e.playbackRate > 1) {
      e.playbackRate = e.wasPlaybackRate;
    } else {
      e.wasPlaybackRate = e.playbackRate;
      e.playbackRate = 2;
    }
  });
}

function injectScript(filePath) {
  var script = document.createElement('script');
  script.setAttribute('type', 'text/javascript');
  script.setAttribute('crossorigin', 'anonymous');
  script.setAttribute('src', chrome.runtime.getURL(filePath));
  document.head.appendChild(script);
}

function onPlay(src) {
  if (src.wasMuted !== src.muted && !src.paused) {
    if (src.muted) {
      chrome.runtime.sendMessage('playMuted');
    } else {
      chrome.runtime.sendMessage('play');
    }
  }
  src.wasMuted = src.muted;
}

// On media play event
window.addEventListener('play', function(event) {
  const src = event.srcElement;
  if (src instanceof HTMLMediaElement) {
    onPlay();
    if (tabPause) pauseElement(src);
    Elements.add(src);
  }
}, { capture: true, passive: true });

window.addEventListener('volumechange', function(event) {
  const src = event.srcElement;
  if (src instanceof HTMLMediaElement) {
    if (src.wasMuted !== src.muted) {
      onPlay();
    }
  }
}, { capture: true, passive: true });

window.addEventListener('pause', event => {
  setTimeout(() => {
    onPause(event);
  }, 100);
}, { capture: true, passive: true });

window.addEventListener('abort', event => {
  onPause(event);
}, { capture: true, passive: true });

function onPause(event) {
  const src = event.srcElement;
  if (src instanceof HTMLMediaElement && src.paused) {
    Elements.delete(src);
    const audibleElements = [...Elements].filter(e => !e.muted);
    if (audibleElements.length === 0) chrome.runtime.sendMessage('pause');
  }
}

// Dont tell the media please
window.addEventListener('ratechange', function(event) {
  const src = event.srcElement;
  if (src instanceof HTMLMediaElement) {
    if (src.playbackRate === 0) {
      chrome.runtime.sendMessage('playbackDisabled');
      if (tabPause) {
        event.stopPropagation();
      }
    } else {
      chrome.runtime.sendMessage('playbackEnabled');
    }
  }
}, { capture: true });

function pauseElement(e) {
  // If media attempts to play when it should be paused dont change its old values.
  if (!e.wasPlaying) {
    e.wasVolume = e.volume;
    e.wasPlaybackRate = e.playbackRate;
  }
  e.volume = 0;
  e.playbackRate = 0;
  e.wasPlaying = true;
}

async function pause() {
  tabPause = true;
  Elements.forEach(e => {
    if (e.paused || e.playbackRate === 0) return;
    pauseElement(e);
  });
}

async function resume(shouldPlay) {
  tabPause = false;
  Elements.forEach(e => {
    if (!document.contains(e)) {
      Elements.delete(e);
      return
    }
    if (!e.wasPlaying) return
    // Pause foreground media normaly
    if (shouldPlay === false) e.pause();
    e.volume = e.wasVolume;
    e.playbackRate = e.wasPlaybackRate;
    e.wasPlaying = false;
  });
}
