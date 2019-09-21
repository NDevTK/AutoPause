chrome.runtime.onMessage.addListener(async(ActiveAudio) => {
	(ActiveAudio) ? pauseALL() : resumeALL();
});

async function pauseALL() {
	pause("video");
	pause("audio");
}

async function resumeALL() {
	resume("video");
	resume("audio");
}

async function pause(tag) {
	let Elements = document.getElementsByTagName(tag);
	for (let Element of Elements) {
		if(Element.paused) return
		Element.pause();
		Element.wasPlaying = true;
	}
}

async function resume(tag) {
	let Elements = document.getElementsByTagName(tag);
	for (let Element of Elements) {
		if(!Element.wasPlaying) return
		Element.play();
		Element.wasPlaying = false;
	}
}
