const puppeteer = require('puppeteer');

const videoTest = "https://www.w3schools.com/html/mov_bbb.mp4";
const audioTest = "https://www.w3schools.com/html/horse.ogg";

(async () => { 
  const extension = require('path').join(__dirname, 'chrome');
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  
  const page = await browser.newPage();
  await browser.close();
})();
