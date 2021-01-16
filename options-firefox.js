'use strict';
/* global browser */
var commands = [];
var shortcuts = document.getElementById('shortcuts');

function commandsUpdate() {
  commands.forEach(command => {
    const id = command.name + "shortcut";
    let element = document.getElementById(id);
    if (element.value !== command.shortcut) {
      browser.commands.update({
        name: command.name,
        shortcut: element.value
      });
    }
  });
}

window.addEventListener('keyup', event => {
  if (event.keyCode === 13) {
    event.preventDefault();
    commandsUpdate();
  }
});

getCommands();

async function getCommands() {
  commands = await browser.commands.getAll();
  commands.forEach(command => {
    const id = command.name + "shortcut";
    let element = document.getElementById(id);
    if (element) {
      element.value = command.shortcut;
      return
    }
    let label = document.createElement("label");
    label.innerText = command.description + " ";
    label.setAttribute("for", id);
    let input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.value = command.shortcut;
    label.appendChild(input);
    shortcuts.appendChild(label);
    let br = document.createElement("br");
    shortcuts.appendChild(br);
  });
};
