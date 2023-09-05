'use strict';
/* global chrome */

var shortcuts = document.getElementById('shortcuts');
var btn = document.createElement('button');
btn.innerText = 'Edit shortcuts';

btn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

shortcuts.appendChild(btn);

var idleButton = document.createElement('button');
idleLabel();

idleButton.addEventListener('click', () => {
  toggleOption('checkIdle');
  idleLabel();
});

function idleLabel() {
  idleButton.innerText = (hasProperty(options, 'checkIdle')) ? 'Disable pause on device lock' : 'Enable pause on device lock';
}
