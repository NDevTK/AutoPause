'use strict';
/* global chrome*/
chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [new chrome.declarativeContent.PageStateMatcher({
        pageUrl: {
          schemes: ['http', 'https', 'file', 'ftp']
        }
      })],
      actions: [new chrome.declarativeContent.RequestContentScript({
        allFrames: true,
        js: ['ContentScript.js']
      })]
    }]);
  });
});
