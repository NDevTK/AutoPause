'use strict';
/* global chrome */

var shortcuts = document.getElementById('shortcuts');
var btn = document.createElement('button');
btn.innerText = 'Edit shortcuts';

btn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

shortcuts.appendChild(btn);


async function idle() {
  const allowed = await chrome.permissions.contains({permissions: ['idle']});
  var btn2 = document.createElement('button');
  btn2.innerText = (allowed) ? 'Disable pause on lock' : 'Enable pause on lock';
  btn2.addEventListener('click', async () => {
    if (allowed) {
      await chrome.permissions.remove({permissions: ['idle']});
    } else {
      await chrome.permissions.request({permissions: ['idle']});
    }
    btn2.innerText = (allowed) ? 'Disable pause on lock' : 'Enable pause on lock';
  });
  document.body.appendChild(btn2);
}

idle();
