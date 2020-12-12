"use strict";
var ActiveAudio = false;
var Elements = [];

chrome.runtime.onMessage.addListener(async (state) => {
    ActiveAudio = state; // React based on state of active tab
    Elements = Elements.filter(e => document.contains(e));
    (ActiveAudio) ? pause(): resume();
});

window.addEventListener('DOMContentLoaded', function(event) {
    // Adds content to DOM
    injectScript("WindowScript.js");
});

function injectScript(file_path) {
    var script = document.createElement('script');
    script.setAttribute('type', 'text/javascript');
    script.setAttribute('src', chrome.extension.getURL(file_path));
    document.head.appendChild(script);
}

window.addEventListener('play', function(event) {
    let e = event.srcElement;
    if (e instanceof HTMLMediaElement === true) {
        if (e.wasPlaying) event.stopPropagation();
        if (ActiveAudio || e.wasPlaying && e.isTrusted) pauseElement(e);
        if (!Elements.includes(e)) Elements.push(e);
    }
}, true);

window.addEventListener('pause', function(event) {
    let e = event.srcElement;
    if (e instanceof HTMLMediaElement === true) {
        if (e.wasPlaying) {
            event.stopPropagation();
        }
    }
}, true);

async function pauseElement(e) {
    if (e.paused) return;
    e.wasPlaying = true;
    await e.pause();
}

async function pause() {
    if (!ActiveAudio) return
    Elements.forEach(e => {
        pauseElement(e);
    });
}

async function resume() {
    Elements.forEach(async e => {
        if (!e.wasPlaying) return
        if (ActiveAudio === null) {
            e.wasPlaying = false;
            e.dispatchEvent(new Event("pause"));
        } else if (e.paused) {
            await e.play();
            e.wasPlaying = false;
        }
    });
}
