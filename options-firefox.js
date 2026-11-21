'use strict';
/* global browser */
let commands = [];
const shortcuts = document.getElementById('shortcuts');
const list = document.createElement('div');
list.className = 'shortcut-list';
shortcuts.appendChild(list);

const actions = document.createElement('div');
actions.className = 'actions';
const saveBtn = document.createElement('button');
saveBtn.type = 'button';
saveBtn.textContent = 'Save shortcuts';
const statusEl = document.createElement('span');
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
  const fetched = await browser.commands.getAll();
  const initialRender = list.childElementCount === 0;
  commands = initialRender
    ? [...fetched].sort(
        (a, b) => Number(Boolean(b.shortcut)) - Number(Boolean(a.shortcut))
      )
    : fetched;
  commands.forEach((command) => {
    const id = command.name + 'shortcut';
    const element = document.getElementById(id);
    if (element) {
      if (!element.classList.contains('is-invalid')) {
        element.value = command.shortcut || '';
      }
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
    input.addEventListener('input', () => {
      input.classList.remove('is-invalid');
      setShortcutStatus('');
    });
    row.append(label, input);
    list.appendChild(row);
  });
}
