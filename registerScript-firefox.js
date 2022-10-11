'use strict';
/* global browser */

var contentscript = null;

function registerScriptFirefox() {
  if (contentscript !== null) {
    contentscript.unregister();
    contentscript = null;
  }
  browser.permissions.getAll(async p => {
    if (p.origins.length < 1) return
    contentscript = await browser.contentScripts.register({
      js: [{
        file: 'ContentScript.js'
      }],
      matches: p.origins,
      allFrames: true,
      runAt: 'document_start'
    });
  });
}

function onAdd() {
    registerScriptFirefox();
    const tabs = await browser.tabs.query({});
    tabs.forEach(tab => {
        if (!tab.url || !tab.id) return;
        browser.tabs.sendMessage(tab.id, {type: 'hi ya!'}).catch(() => {
            await browser.tabs.executeScript(tab.id, {
                file: 'ContentScript.js',
                allFrames: true,
                runAt: 'document_start'
            });
            send(tab.id, 'new', true);
        });
    });
}

browser.permissions.onAdded.addListener(onAdd);
browser.permissions.onRemoved.addListener(registerScriptFirefox);
registerScriptFirefox();
