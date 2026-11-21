'use strict';
/* global browser */
var commands = [];
var shortcuts = document.getElementById('shortcuts');
var list = document.createElement('div');
list.className = 'shortcut-list';
shortcuts.appendChild(list);

var actions = document.createElement('div');
actions.className = 'actions';
var saveBtn = document.createElement('button');
saveBtn.type = 'button';
saveBtn.textContent = 'Save shortcuts';
var statusEl = document.createElement('span');
statusEl.className = 'status';
statusEl.setAttribute('role', 'status');
statusEl.setAttribute('aria-live', 'polite');
actions.append(saveBtn, statusEl);
shortcuts.appendChild(actions);

function setShortcutStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'status error' : 'status';
}

async function commandsUpdate() {
  let hadError = false;
  let updated = false;
  for (const command of commands) {
    const id = command.name + 'shortcut';
    const element = document.getElementById(id);
    if (!element) continue;
    const nextValue = element.value.trim();
    if (nextValue !== (command.shortcut || '')) {
      try {
        await browser.commands.update({
          name: command.name,
          shortcut: nextValue
        });
        element.classList.remove('is-invalid');
        updated = true;
      } catch {
        element.classList.add('is-invalid');
        hadError = true;
      }
    }
  }
  await getCommands();
  if (hadError) {
    setShortcutStatus('Invalid shortcut (e.g. Alt+Shift+P).', true);
  } else if (updated) {
    setShortcutStatus('Shortcuts saved.');
  }
}

saveBtn.addEventListener('click', commandsUpdate);

shortcuts.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
    event.preventDefault();
    commandsUpdate();
  }
});

getCommands();

async function getCommands() {
  commands = await browser.commands.getAll();
  commands.forEach((command) => {
    const id = command.name + 'shortcut';
    const element = document.getElementById(id);
    if (element) {
      element.value = command.shortcut || '';
      return;
    }
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    const label = document.createElement('label');
    label.textContent = command.description;
    label.setAttribute('for', id);
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.placeholder = 'Not set';
    input.value = command.shortcut || '';
    input.addEventListener('input', () => input.classList.remove('is-invalid'));
    row.append(label, input);
    list.appendChild(row);
  });
}
