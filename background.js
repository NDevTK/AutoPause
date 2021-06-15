'use strict';
/* global chrome */
var media = new Set(); // List of tabs with media.
var options = {};
var backgroundaudio = new Set();
var mediaPlaying = null; // Tab ID of active media.
var activeTab = null;
var lastPlaying = null;
var otherTabs = new Set(); // Tab IDs of audible tabs with no permission to access.
var mutedTabs = new Set(); // Tab IDs of muted tabs.
var ignoredTabs = new Set();

chrome.storage.sync.get('options', result => {
    if (typeof result.options === 'object' && result.options !== null)
        options = result.options;
});

chrome.storage.onChanged.addListener(result => {
    if (typeof result.options === 'object' && result.options !== null)
        options = result.options.newValue
});

// On install display the options page so the user can give permissions.
chrome.runtime.onInstalled.addListener(details => {
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});

// For when the media is silent.
chrome.runtime.onMessage.addListener((message, sender) => {
    if (!hasProperty(sender, 'tab') || ignoredTabs.has(sender.tab.id)) return
    switch (message) {
        case 'play':
            media.add(sender.tab.id);
            onPlay(sender.tab);
            break
        case 'playMuted':
            mutedTabs.add(sender.tab.id);
            media.delete(sender.tab.id);
            onPause(sender.tab.id);
            break
        case 'playTrusted':
            media.add(sender.tab.id);
            onPlay(sender.tab, true);
            break
        case 'pause':
            media.delete(sender.tab.id);
            onPause(sender.tab.id);
            break
        }
});

function onPlay(tab, trusted = false) {
    if (hasProperty(options, 'multipletabs') && tab.id !== activeTab) return
    // Dont allow a diffrent tab to hijack active media.
    if (tab.id !== activeTab && tab.id !== lastPlaying && mediaPlaying !== tab.id && !trusted) {
        return Broadcast('pause', activeTab);
    };
    mediaPlaying = tab.id;
    if (tab.id == activeTab || trusted)
        lastPlaying = null;
    if (media.has(tab.id)) {
        mutedTabs.delete(tab.id);
        // Make tab top priority.
        otherTabs.delete(tab.id);
        media.delete(tab.id);
        media.add(tab.id);
    }
    if (tab.audible) return
    // Pause all other media.
    Broadcast('pause', tab.id);
}

function onPause(id) {
    // Ignore event from other tabs.
    if (id === mediaPlaying) {
        lastPlaying = id;
        autoResume(id);
    }
}

function tabChange(tab) {
    if (ignoredTabs.has(tab.id)) return
    
    activeTab = tab.id;

    if (hasProperty(options, 'ignoretabchange')) return
    
    if (hasProperty(options, 'pauseoninactive')) {
        // Pause all except active tab
        Broadcast('pause', tab.id);
    }

    // Pause inactive muted tabs.
    Broadcast('pause', tab.id, mutedTabs);

    if (media.has(tab.id) || mutedTabs.has(tab.id)) {
        play(tab.id);
    } else if (otherTabs.has(tab.id)) {
        onPlay(tab);
    }

    if (hasProperty(options, 'multipletabs') && !media.has(tab.id)) {
        autoResume(tab.id);
    }
}

function getResumeTab() {
    const tabs = (backgroundaudio.size > 0 || hasProperty(options, 'pauseoninactive')) ? backgroundaudio : media;
    const resumableMedia = Array.from(tabs);
    if (resumableMedia.length > 0) {
        return resumableMedia.pop();
    }
    return false
}

// User may have mutiple windows open.
chrome.windows.onFocusChanged.addListener(id => {
    if (id === chrome.windows.WINDOW_ID_NONE) return
    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, tabs => {
        if (tabs.length === 1) {
            tabChange(tabs[0]);
        }
    });
});

// Handle keyboard shortcuts.
chrome.commands.onCommand.addListener(async command => {
    switch (command) {
    case 'gotoaudible':
        // Go to audible tab thats not active.
        chrome.tabs.query({
            audible: true,
            active: false,
            currentWindow: true
        }, tabs => {
            if (tabs.length > 0) {
                chrome.tabs.update(tabs[0].id, {
                    active: true
                });
            } else if (media.size > 0) {
                const result = getResumeTab();
                if (result !== false) {
                    chrome.tabs.update(result, {
                        active: true
                    });
                }
            }
        });
        break
    case 'disableresume':
        toggleOption('disableresume');
        break
    case 'toggleFastPlayback':
        Broadcast('toggleFastPlayback');
        break
    case 'togglePlayback':
        var result = getResumeTab();
        if (result !== false) {
            Broadcast('pause', result);
            if (otherTabs.size === 0)
                chrome.tabs.sendMessage(result, 'togglePlayback');
        }
        break
    case 'next':
        Broadcast('next');
        break
    case 'previous':
        Broadcast('previous');
        break
    case 'pauseoninactive':
        toggleOption('pauseoninactive');
        break
    case 'backgroundaudio':
        chrome.tabs.query({
            active: true,
            currentWindow: true
        }, tabs => {
            if (tabs.length === 0) return
            // Currently only has one tab
            backgroundaudio.clear();
            backgroundaudio.add(tabs[0].id);
        });
        break
    case 'ignoretab':
        chrome.tabs.query({
            active: true,
            currentWindow: true
        }, tabs => {
            if (tabs.length === 0) return
            ignoredTabs.add(tabs[0].id);
            remove(tabs[0].id);
        });
        break
    }
});

function play(id) {
    if (hasProperty(options, 'disableresume')) {
        chrome.tabs.sendMessage(id, 'allowplayback');
    } else {
        chrome.tabs.sendMessage(id, 'play');
    }
}

function autoResume(id) {
    if (hasProperty(options, 'disableresume') || media.size === 0 || otherTabs.size > 0) return
    if (hasProperty(options, 'multipletabs') && backgroundaudio.size === 0) {
        // Resume all tabs when multipletabs is enabled.
        return Broadcast('play');
    }
    // Make sure event is from the mediaPlaying tab.
    if (id === mediaPlaying) {
        const result = getResumeTab();
        mediaPlaying = result;
        if (result !== false)
            chrome.tabs.sendMessage(result, 'play');
    }
}

// On tab change
chrome.tabs.onActivated.addListener(info => {
    chrome.tabs.get(info.tabId, tab => {
        tabChange(tab);
    });
});

chrome.tabs.onRemoved.addListener(tabId => {
    ignoredTabs.delete(tabId);
    remove(tabId);
});

function remove(tabId) {
    media.delete(tabId);
    otherTabs.delete(tabId);
    backgroundaudio.delete(tabId);
    mutedTabs.delete(tabId);
    onPause(tabId);
}

// Detect changes to audible status of tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (ignoredTabs.has(tabId)) return
    if (!hasProperty(changeInfo, 'audible')) return // Bool that contains if audio is playing on tab.
    if (changeInfo.audible) {
        // If has not got a play message from the content script assume theres no permission.
        if (!media.has(tabId)) otherTabs.add(tabId);
        onPlay(tab);
    } else {
        otherTabs.delete(tabId);
        onPause(tabId);
    }
});

async function Broadcast(message, exclude = false, tabs = media) {
    tabs.forEach(id => { // Only for tabs that have had media.
        if (id === exclude || id === lastPlaying) return
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
        }, function (result) {
            resolve(result);
        });
    });
}
