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
      },{
        file: 'utils-firefox.js'
      }],
      matches: p.origins,
      allFrames: true,
      runAt: 'document_start'
    });
  });
}

browser.permissions.onAdded.addListener(registerScriptFirefox);
browser.permissions.onRemoved.addListener(registerScriptFirefox);
registerScriptFirefox();
