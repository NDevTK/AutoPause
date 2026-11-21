'use strict';
/* global chrome */
const chromeonly = document.getElementById('chromeonly');
chromeonly.hidden = false;

const shortcuts = document.getElementById('shortcuts');
const list = document.createElement('div');
list.className = 'shortcut-list';
shortcuts.appendChild(list);

const btn = document.createElement('button');
btn.type = 'button';
btn.textContent = 'Edit shortcuts';

btn.addEventListener('click', () => {
  chrome.tabs.create({url: 'chrome://extensions/shortcuts'});
});

shortcuts.appendChild(btn);

let renderSeq = 0;

function renderShortcuts() {
  if (!chrome.commands?.getAll) return;
  const seq = ++renderSeq;
  chrome.commands.getAll((commands) => {
    if (
      seq !== renderSeq ||
      chrome.runtime.lastError ||
      !Array.isArray(commands)
    ) {
      return;
    }
    const sorted = [...commands].sort(
      (a, b) => Number(Boolean(b.shortcut)) - Number(Boolean(a.shortcut))
    );
    const fragment = document.createDocumentFragment();
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
      fragment.appendChild(row);
    });
    list.replaceChildren(fragment);
  });
}

renderShortcuts();
window.addEventListener('focus', renderShortcuts);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderShortcuts();
});
