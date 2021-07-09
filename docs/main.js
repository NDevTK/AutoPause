const videoTest = "https://www.w3schools.com/html/mov_bbb.mp4";
const audioTest = "https://www.w3schools.com/html/horse.ogg";

var media = new Audio(audioTest);
media.loop = true;

async function test() {
  result.innerText = "";
  media.playbackRate = 1;
  media.play();
  let w = open();
  
  for (var i=1;i<=5; i++) {
  w.location = videoTest;
  await sleep();
  media.playbackRate = 1;
  await sleep();
  if (media.playbackRate !== 0) onError("Failed to pause for video");
  await sleep(11000);
  if (media.playbackRate === 0) onError("Failed to resume after video");
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
  }
  
  w.close();
  media.pause();  
}

function onError(error) {
  console.error(error);
  result.innerText += "\n"+error;
}

function sleep(ms = 1000) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
