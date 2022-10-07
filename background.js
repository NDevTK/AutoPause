'use strict';
/* global chrome */
var media = new Set(); // List of tabs with media.
var options = {};
var backgroundaudio = new Set();
var mediaPlaying = null; // Tab ID of active media.
var activeTab = null;
var lastPlaying = null;
var otherTabs = new Set(); // Tab IDs of media with no permission to access.
var mutedTabs = new Set(); // Tab IDs of muted media.
var ignoredTabs = new Set();
var autoPauseWindow = null;

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

function onMute(tabId) {
    mutedTabs.add(tabId);
    if (!hasProperty(options, 'muteonpause')) media.delete(tabId);
    onPause(tabId);
}

// For when the media is silent.
chrome.runtime.onMessage.addListener(async (message, sender) => {
    if (autoPauseWindow !== null  && autoPauseWindow !== sender.tab.windowId) return
    otherTabs.delete(sender.tab.id);
    if (!hasProperty(sender, 'tab') || ignoredTabs.has(sender.tab.id)) return
    switch (message) {
        case 'hidden':
            if (sender.frameId === 0 && mutedTabs.has(sender.tab.id)) {
                // Pause hidden muted tabs.
                pause(sender.tab.id);
            }
            break
        case 'play':
            if (sender.tab.mutedInfo.muted) {
                if (hasProperty(options, 'muteonpause')) media.add(sender.tab.id);
                onMute(sender.tab.id);
            } else {
                media.add(sender.tab.id);
                onPlay(sender.tab);
            }
            break
        case 'playMuted':
            let playing = await isPlaying(sender.tab.id);
            if (playing) break
            onMute(sender.tab.id);
            break
        case 'pause':
            let playing = await isPlaying(sender.tab.id);
            if (playing) break
            remove(sender.tab.id);
            break
        }
});

function onPlay(tab) {
    if (autoPauseWindow !== null  && autoPauseWindow !== tab.windowId) return
    
    if (hasProperty(options, 'ignoreother') && otherTabs.has(tab.id)) return
    
    if (hasProperty(options, 'multipletabs') && tab.id !== activeTab) return
    // Dont allow a diffrent tab to hijack active media.
    if (tab.id !== activeTab && tab.id !== lastPlaying && mediaPlaying !== tab.id) {
	    return pause(tab.id);
    };
    mediaPlaying = tab.id;

    if (hasProperty(options, 'muteonpause')) chrome.tabs.update(tab.id, {"muted": false});

    if (tab.id == activeTab)
        lastPlaying = null;
    if (media.has(tab.id)) {
        mutedTabs.delete(tab.id);
        // Make tab top priority.
        media.delete(tab.id);
        media.add(tab.id);
    }
    // Pause all other media.
    if (tab.audible)
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
    
    if (autoPauseWindow !== null  && autoPauseWindow !== tab.windowId) return
    
    activeTab = tab.id;

    if (hasProperty(options, 'ignoretabchange')) return
    
    if (hasProperty(options, 'pauseoninactive')) {
        // Pause all except active tab
        Broadcast('pause', tab.id);
    }
	
    if (media.has(tab.id) || mutedTabs.has(tab.id)) {
        play(tab.id);
    } else if (otherTabs.has(tab.id)) {
        onPlay(tab);
    }
}

function getResumeTab(exclude) {
    const tabs = (backgroundaudio.size > 0 || hasProperty(options, 'pauseoninactive')) ? backgroundaudio : media;
    const resumableMedia = Array.from(tabs).filter(id => id !== exclude);
    if (resumableMedia.length > 0) {
        return resumableMedia.pop();
    }
    return false
}

// User may have mutiple windows open.
chrome.windows.onFocusChanged.addListener(id => {
    if (id === chrome.windows.WINDOW_ID_NONE) return
    if (autoPauseWindow !== null  && autoPauseWindow !== id) return
    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, tabs => {
        if (tabs.length === 1) {
            tabChange(tabs[0]);
        }
    });
});

// Dont track unrelated windows
chrome.tabs.onDetached.addListener(id => {
    if (autoPauseWindow === null) return
    remove(id);
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
    case 'Rewind':
        Broadcast('Rewind');
        break
    case 'togglePlayback':
        var result = getResumeTab();
        if (result !== false) {
            Broadcast('pause', result);
            if (otherTabs.size === 0) send(result, 'togglePlayback');
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
            // Currently only has one tab
            backgroundaudio.clear();
            backgroundaudio.add(activeTab);
        break
    case 'ignoretab':
            ignoredTabs.add(activeTab);
            remove(activeTab);
        break
    case 'previoustab':
            lastPlaying = null;
            switchMedia();
        break
    case 'autopausewindow':
            chrome.windows.getCurrent(w => {
                if (w.id === chrome.windows.WINDOW_ID_NONE) return
                autoPauseWindow = w.id;
            });
       break
    }
});

function pause(id, checkHidden) {
	if (hasProperty(options, 'nopermission')) {
		chrome.tabs.discard(id);
		return
	}
	if (otherTabs.has(id)) return
	if (hasProperty(options, 'muteonpause')) chrome.tabs.update(id, {"muted": true});
	if (checkHidden) {
		send(id, 'hidden');
	} else {
		send(id, 'pause');
	}
}

function play(id, force) {
    if (hasProperty(options, 'muteonpause')) chrome.tabs.update(id, {"muted": false});
    if (hasProperty(options, 'disableresume') && !force) {
        send(id, 'allowplayback');
    } else {
        send(id, 'play');
    }
}

function switchMedia() {
    const result = getResumeTab(mediaPlaying);
    mediaPlaying = result;
    if (result !== false)
        play(result);
}

function autoResume(id) {
    if (hasProperty(options, 'disableresume') || media.size === 0 || otherTabs.size > 0 && !hasProperty(options, 'ignoreother')) return
    if (hasProperty(options, 'multipletabs') && backgroundaudio.size === 0) {
        // Resume all tabs when multipletabs is enabled.
        return Broadcast('play');
    }
    // Make sure event is from the mediaPlaying tab.
    if (id === mediaPlaying) {
        switchMedia();
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
    if (autoPauseWindow !== null  && autoPauseWindow !== tab.windowId) return
    if (ignoredTabs.has(tabId)) return
    if (changeInfo.discarded) {
        return remove(tabId);
    }
    if (hasProperty(changeInfo, 'mutedInfo')) {
        if (changeInfo.mutedInfo.muted && media.has(tabId)) {
            // Pause hidden muted tabs.
            pause(tabId, true);
            onMute(tabId);
        }
	    // If tab gets unmuted resume it.
        else if (!changeInfo.mutedInfo.muted && mutedTabs.has(tabId)) {
            mediaPlaying = tabId;
            play(tabId, true);
        }
    }
    if (!hasProperty(changeInfo, 'audible')) return // Bool that contains if audio is playing on tab.
    
    if (changeInfo.audible) {
        // If has not got a play message from the content script assume theres no permission.
        if (!media.has(tabId)) {
            // Allow the media to check its shadow dom.
            send(tabId, 'audible');
            otherTabs.add(tabId);
        }
        onPlay(tab);
    } else {
	send(tabId, 'update');
        otherTabs.delete(tabId);
        onPause(tabId);
    }
});

async function Broadcast(message, exclude = false, tabs = media) {
    tabs.forEach(id => { // Only for tabs that have had media.
        if (id === exclude || id === lastPlaying) return
		if (message === 'pause') {
			return pause(id);
		}
        send(id, message);
    });
    // User does not want otherTabs to be affected
    if (hasProperty(options, 'ignoreother')) return
    // Expand scope of pause to otherTabs if discarding is enabled.
    if (hasProperty(options, 'nopermission') && message === 'pause' && tabs === media) {
        Broadcast(message, exclude, otherTabs);
    };
};

function send(id, message, force) {
	if (otherTabs.has(id) && !force) return
	chrome.tabs.sendMessage(id, message, r => {
		var lastError = chrome.runtime.lastError; // lgtm [js/unused-local-variable]
	});
}

function isPlaying(id) {
    return new Promise(resolve => {
        if (otherTabs.has(id)) return true
        chrome.tabs.sendMessage(id, 'isplaying', r => {
            var lastError = chrome.runtime.lastError; // lgtm [js/unused-local-variable]
            resolve(r === 'true');
        });
    });
}

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
