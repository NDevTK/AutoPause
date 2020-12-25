"use strict";
var sounds = []; // List of tab ids that have had audio
var options = {};

chrome.storage.sync.get("options", function(result) {
    if (typeof result["options"] === 'object' && result["options"] !== null) options = result["options"];
});

chrome.runtime.onInstalled.addListener(function(details) {
    if (details.reason == "install") {
        chrome.runtime.openOptionsPage();
    }
});

chrome.windows.onFocusChanged.addListener(id => {
    if (id === -1) return
    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, tab => {
        if (tab.length !== 1) return
        checkOrigin(tab[0]);
    });
});

chrome.commands.onCommand.addListener(async command => {
    switch (command) {
        case "gotoaudible":
            chrome.tabs.query({
                audible: true,
                active: false,
                currentWindow: true
            }, tab => {
                if (tab.length < 1) return
                chrome.tabs.update(tab[0].id, {
                    active: true
                });
            });
            return
        case "disableresume":
            toggleOption("disableresume");
            return
        case "toggleFastPlayback":
            Broadcast("toggleFastPlayback");
            return
    }
});

function checkOrigin(tab) {
    if (tab.active === false || tab.id === undefined) return
    let message = tab.audible;
    if (options.hasOwnProperty("disableresume")) {
        chrome.tabs.sendMessage(tab.id, null, sendHandler); // Only allow playback
        if (message === false) return
    } else {
        chrome.tabs.sendMessage(tab.id, false, sendHandler); // Resume when active
    }
    Broadcast(message, tab.id);
}

function sendHandler() {
    let lastError = chrome.runtime.lastError;
}

chrome.tabs.onActivated.addListener(info => {
    chrome.tabs.get(info.tabId, tab => {
        checkOrigin(tab);
    });
});

chrome.tabs.onRemoved.addListener(tabId => {
    sounds = sounds.filter(id => id !== tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.hasOwnProperty("audible")) return // Bool that contains if audio is playing on tab
    if (changeInfo.audible && !sounds.includes(tabId)) {
        sounds.push(tabId);
    }
    if (options.hasOwnProperty("disableresume") && changeInfo.audible === false) return
    if (tab.active) {
        Broadcast(changeInfo.audible, tabId, sendHandler); // Tell the other tabs the state of the active tab
    }
});

async function Broadcast(message, exclude = false) {
    sounds.forEach(id => { // Only for tabs that have had sound
        if (id === exclude) return
        chrome.tabs.sendMessage(id, message, sendHandler);
    });
};

function toggleOption(o) {
    if (options.hasOwnProperty(o)) {
        delete options[o];
    } else {
        options[o] = true;
    }
    return new Promise(resolve => {
        chrome.storage.sync.set({
            options
        }, function(result) {
            resolve(result);
        });
    });
}
