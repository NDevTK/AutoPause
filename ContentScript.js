ActiveAudio = false;

chrome.runtime.onMessage.addListener(async (state) => {
    ActiveAudio = state; // React based on state of active tab
    main();
});

document.onplay = main;

async function main() {
    (ActiveAudio) ? pause(): resume();
}



async function pause() {
    let Elements = [...document.getElementsByTagName("*")];
    Elements.forEach(e => {
        if (e instanceof HTMLMediaElement === false || e.paused) return;
        e.pause();
        e.wasPlaying = true;
    });
}

async function resume() {
    let Elements = [...document.getElementsByTagName("*")];
    Elements.forEach(e => {
        if (e instanceof HTMLMediaElement === false || !e.wasPlaying) return
        e.play();
        e.wasPlaying = false;
    });
}
