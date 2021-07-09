const rickrollTest = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const audioTest = "https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3";

var media = new Audio(audioTest);
media.loop = true;

async function test() {
  let w = open(rickrollTest);
  await sleep();
  media.playbackRate = 1;
  await sleep();
  if (media.playbackRate !== 0) onError("Failed to pause for video");
  w.location = "https://example.com";
  await sleep();
  if (media.playbackRate === 0) onError("Failed to play"); 
  media.playbackRate = 2;
  w.location = audioTest;
  await sleep();
  if (media.playbackRate !== 0) onError("Failed to pause for audio");
  w.location = "https://example.org";
  await sleep();
  if (media.playbackRate !== 2) onError("Failed to set playbackRate of 2"); 
  w.close();
}

function onError(error) {
  console.error(error);
}

function sleep(ms = 1000) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
