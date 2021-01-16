'use strict';
/* global chrome */

var shortcuts = document.getElementById('shortcuts');
var a = document.createElement('a');
a.setAttribute('href', "chrome://extensions/shortcuts");

var btn = document.createElement("button");
btn.innerText = "Edit shortcuts";

btn.addEventListener("click", () => {
  window.open("chrome://extensions/shortcuts");
})

shortcuts.appendChild(btn);
