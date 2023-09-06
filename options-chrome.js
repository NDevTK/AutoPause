'use strict';
/* global chrome */
var chromeonly = document.getElementById('chromeonly');
chromeonly.hidden = false;

var shortcuts = document.getElementById('shortcuts');
var btn = document.createElement('button');
btn.innerText = 'Edit shortcuts';

btn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

shortcuts.appendChild(btn);
