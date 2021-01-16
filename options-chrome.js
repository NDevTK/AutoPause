'use strict';
/* global chrome */

var shortcuts = document.getElementById('shortcuts');
var btn = document.createElement("button");
btn.innerText = "Edit shortcuts";

btn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

shortcuts.appendChild(btn);
