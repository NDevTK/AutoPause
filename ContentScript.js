ActiveAudio = false;

chrome.runtime.onMessage.addListener(async (state) => {
    ActiveAudio = state; // React based on state of active tab
    main();
});

document.onplay = main;

async function main() {
    (ActiveAudio) ? pause(): resume();
}

function checkInvalid(e) {
    return (e.getRootNode() instanceof ShadowRoot === true || e instanceof HTMLMediaElement === false);
}

async function pause() {
    let Elements = [...document.getElementsByTagName("*")];
    Elements.forEach(e => {
        if (checkInvalid(e) || e.paused) return;
        e.pause();
        e.wasPlaying = true;
    });
}

async function resume() {
    let Elements = [...document.getElementsByTagName("*")];
    Elements.forEach(e => {
        if (checkInvalid(e) || !e.wasPlaying) return
        e.play();
        e.wasPlaying = false;
    });
}
