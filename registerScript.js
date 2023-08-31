'use strict';
/* global chrome */

function registerScript() {
  browser.permissions.getAll(async p => {
    if (p.origins.length < 1) return
     chrome.scripting.registerContentScript({
      js: [{
        file: 'ContentScript.js'
      }],
      matches: p.origins,
      allFrames: true,
      runAt: 'document_start'
    });
  });
}

async function onAdd() {
    registerScript();
    const tabs = await chrome.tabs.query({});
    tabs.forEach(async tab => {
        if (!tab.url || !tab.id) return;
        chrome.tabs.sendMessage(tab.id, {type: 'hi ya!'}).catch(async () => {
            await chrome.tabs.executeScript(tab.id, {
                file: 'ContentScript.js',
                allFrames: true,
                runAt: 'document_start'
            });
            send(tab.id, 'new', true);
        });
    });
}

chrome.permissions.onAdded.addListener(onAdd);
chrome.permissions.onRemoved.addListener(registerScript);
registerScript();
