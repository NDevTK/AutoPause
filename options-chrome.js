'use strict';
/* global chrome */
var chromeonly = document.getElementById('chromeonly');
chromeonly.hidden = false;

var shortcuts = document.getElementById('shortcuts');
var list = document.createElement('div');
list.className = 'shortcut-list';
shortcuts.appendChild(list);

var btn = document.createElement('button');
btn.type = 'button';
btn.textContent = 'Edit shortcuts';

btn.addEventListener('click', () => {
  chrome.tabs.create({url: 'chrome://extensions/shortcuts'});
});

shortcuts.appendChild(btn);

if (chrome.commands?.getAll) {
  chrome.commands.getAll((commands) => {
    if (chrome.runtime.lastError || !Array.isArray(commands)) return;
    const sorted = [...commands].sort(
      (a, b) => Number(Boolean(b.shortcut)) - Number(Boolean(a.shortcut))
    );
    sorted.forEach((command) => {
      if (!command.description) return;
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const desc = document.createElement('span');
      desc.textContent = command.description;
      const key = document.createElement('kbd');
      key.textContent = command.shortcut || 'Not set';
      if (!command.shortcut) key.className = 'unset';
      row.append(desc, key);
      list.appendChild(row);
    });
  });
}
