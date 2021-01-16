'use strict';
/* global chrome */

var btn = document.createElement("button");
btn.innerText = "Edit shortcuts";

btn.addEventListener("click", () => {
  window.open("chrome://extensions/shortcuts");
})

shortcuts.appendChild(btn);
