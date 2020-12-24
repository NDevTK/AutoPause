chrome.runtime.onInstalled.addListener(function(details) {
    chrome.declarativeContent.onPageChanged.removeRules(undefined, function() {
        chrome.declarativeContent.onPageChanged.addRules([{
            conditions: [new chrome.declarativeContent.PageStateMatcher({
                pageUrl: {
                    schemes: ["http", "https", "file", "ftp"]
                }
            })],
            actions: [new chrome.declarativeContent.RequestContentScript({
                allFrames: true,
                js: ["ContentScript.js"]
            })]
        }]);
    });
    if (details.reason == "install") {
        chrome.runtime.openOptionsPage();
    }
});
