"use strict";
var ActiveAudio = false;
var Elements = [];

chrome.runtime.onMessage.addListener(async (state) => {
    ActiveAudio = state; // React based on state of active tab
    (ActiveAudio) ? pause(): resume();
});

window.addEventListener('play', function(event) {
    let src = event.srcElement;
    if (src instanceof HTMLMediaElement === true) {
        if (ActiveAudio) src.pause();
        if (!Elements.includes(src)) Elements.push(src);
    }
}, true);


async function pause() {
    Elements.forEach(e => {
        if (e.paused) return;
        e.pause();
        e.wasPlaying = true;
    });
}

async function resume() {
    Elements.forEach(e => {
        if (!e.wasPlaying) return
        e.play();
        e.wasPlaying = false;
    });
}
