"use strict";

// Script should only run once
if (ActiveMedia === undefined) {
    var ActiveMedia = false;
    var Elements = new Set();
}

chrome.runtime.onMessage.addListener(async (state) => {
    if (state === "toggleFastPlayback") {
        toggleRate();
        return
    }
    ActiveMedia = state; // React based on state of active tab
    (ActiveMedia) ? pause(): resume();
});

window.addEventListener('DOMContentLoaded', function(event) {
    // Adds content to DOM
    injectScript("WindowScript.js");
}, {passive: true});

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


function injectScript(file_path) {
    var script = document.createElement('script');
    script.setAttribute('type', 'text/javascript');
    script.setAttribute('crossorigin', 'anonymous');
    script.setAttribute('src', chrome.runtime.getURL(file_path));
    document.head.appendChild(script);
}

window.addEventListener('play', function(event) {
    let src = event.srcElement;
    if (src instanceof HTMLMediaElement) {
        chrome.runtime.sendMessage("play");
        if (ActiveMedia) pauseElement(src);
        if (!Elements.has(src)) {
            Elements.add(src);
            src.addEventListener("pause", onPause, {once: true, passive: true});
        }
    }
}, {capture: true, passive: true});


function onPause(event) {
    let src = event.srcElement;
    if (src instanceof HTMLMediaElement) {
        Elements.delete(src);
        if (Elements.size === 0) chrome.runtime.sendMessage("pause");
    }
}

// Dont tell the media please
window.addEventListener('ratechange', function(event) {
    let src = event.srcElement;
    if (src instanceof HTMLMediaElement === true) {
        if (ActiveMedia && src.playbackRate === 0) {
            event.stopPropagation();
        }
    }
}, {capture: true});

function pauseElement(e) {
    if (!e.wasPlaying) {
        e.wasVolume = e.volume;
        e.wasPlaybackRate = e.playbackRate;
    }
    e.volume = 0;
    e.playbackRate = 0;
    e.wasPlaying = true;
}

async function pause() {
    Elements.forEach(e => {
        if (e.paused || e.playbackRate === 0) return;
        pauseElement(e);
    });
}

async function resume() {
    Elements.forEach(e => {
        if (!e.wasPlaying) return
        // Pause foreground media normaly
        if (ActiveMedia === null) e.pause();
        e.volume = e.wasVolume;
        e.playbackRate = e.wasPlaybackRate;
        e.wasPlaying = false;
    });
}
