"use strict";
/*global chrome*/
var media = new Map(); // List of tabs with media
var options = {};
var backgroundaudio = new Map();
var mediaPlaying = null; // Tab ID of active media

chrome.storage.sync.get("options", result => {
    if (typeof result["options"] === 'object' && result["options"] !== null) options = result["options"];
});

chrome.storage.onChanged.addListener(changes => {
    if (hasProperty(changes, "options")) {
        options = changes["options"].newValue;
    }
});

// On install display the options page so the user can give permissions
chrome.runtime.onInstalled.addListener(details => {
    if (details.reason == "install") {
        chrome.runtime.openOptionsPage();
    }
});

// For when the media is silent
chrome.runtime.onMessage.addListener((message, sender) => {
    if (!hasProperty(sender, "tab")) return
    switch(message) {
        case "play":
            media.set(sender.tab.id);
            checkOrigin(sender.tab, true);
            break
        case "playMuted":
            media.set(sender.tab.id, "muted");
            break
        case "pause":
            media.delete(sender.tab.id);
            checkOrigin(sender.tab, false);
            break
    }
});

function getResumeTabs() {
    if (backgroundaudio.size > 0) {
        return backgroundaudio;
    } else {
        let resumableMedia = Array.from(media).filter(s => s[1] !== "muted");
        if (resumableMedia.length > 0) {
            let lastActive = resumableMedia.pop();
            return new Map().set(lastActive[0], lastActive[1]);
        }
    }
    return false
}

// User may have mutiple windows open
chrome.windows.onFocusChanged.addListener(id => {
    if (id === -1) return
    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, tabs => {
        if (tabs.length !== 1) return
        checkOrigin(tabs[0]);
    });
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(async command => {
    switch (command) {
        case "gotoaudible":
            // Go to audible tab thats not active 
            chrome.tabs.query({
                audible: true,
                active: false,
                currentWindow: true
            }, tabs => {
                if (tabs.length > 0) {
                    chrome.tabs.update(tabs[0].id, {active: true});
                } else if (media.size > 0) {
                    let result = getResumeTabs();
                    if (result !== false) chrome.tabs.update(Array.from(result)[0][0], {active: true});
                }
            });
            break
        case "disableresume":
            toggleOption("disableresume");
            break
        case "toggleFastPlayback":
            Broadcast("toggleFastPlayback");
            break
        case "pauseoninactive":
            toggleOption("pauseoninactive");
            break
        case "backgroundaudio":
            chrome.tabs.query({active: true, currentWindow: true}, tabs => {
                if(tabs.length === 0) return
                // Currently only has one tab
                backgroundaudio.clear();
                backgroundaudio.set(tabs[0].id);
            });
            break
    }
});

// Controls what gets paused or resumed
async function checkOrigin(tab, override = null) {
    if (tab.active === false || tab.id === undefined) return
    let activePlaying = (override === null) ? tab.audible : override;
    let metadata = media.get(tab.id);
    
    if (activePlaying && media.has(tab.id)) {
        // Make tab top priority and keep metadata
        media.delete(tab.id);
        media.set(tab.id, metadata);
    }
    
    // Attempt to play media
    if (activePlaying === false && metadata !== "noPermission") {
        if (hasProperty(options, "disableresume")) {
            chrome.tabs.sendMessage(tab.id, "allowplayback");
        } else {
            chrome.tabs.sendMessage(tab.id, "play");
        }
        return
    }
    
    if (activePlaying === true || hasProperty(options, "pauseoninactive")) {
        Broadcast("pause", tab.id);
        mediaPlaying = tab.id;
    } else {
        if (hasProperty(options, "disableresume") || media.size === 0) return
        let resumeTabs = false;
        if (hasProperty(options, "multipletabs") && backgroundaudio.size === 0) {
            resumeTabs = media;
        } else if (tab.id !== mediaPlaying) {
            return
        } else {
           resumeTabs = getResumeTabs();
        }
        if(resumeTabs === false) return
        Broadcast("play", tab.id, resumeTabs);
    }
}

// On tab change
chrome.tabs.onActivated.addListener(info => {
    chrome.tabs.get(info.tabId, tab => {
        checkOrigin(tab);
    });
});

chrome.tabs.onRemoved.addListener(tabId => {
    media.delete(tabId);
    backgroundaudio.delete(tabId);
});

// Detect changes to audible status of tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!hasProperty(changeInfo, "audible")) return // Bool that contains if audio is playing on tab
    if(!media.has(tab.id)) media.set(tab.id, "noPermission");
    checkOrigin(tab);
});

async function Broadcast(message, exclude = false, tabs = media) {
    tabs.forEach((metadata, id) => { // Only for tabs that have had sound
        if (id === exclude || metadata === "noPermission") return
        chrome.tabs.sendMessage(id, message);
    });
};

function hasProperty(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

// Saves options to storage
function toggleOption(o) {
    if (hasProperty(options, o)) {
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
