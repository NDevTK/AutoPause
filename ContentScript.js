'use strict';
/* global chrome */

(() => {
    // Script should only run once

    if (hasProperty(window, "loaded")) return
    
    var loaded = 'yep';
    
    function API(e) {
    	document.dispatchEvent(new CustomEvent("autopause_action", {detail: e}));
    }

    chrome.runtime.onMessage.addListener(message => {
        switch (message) {
	case 'pausemuted':
            checkVisibility();	
            break
        case 'toggleFastPlayback':
            API('toggleFastPlayback');
            break
        case 'Rewind':
            API('Rewind');
            break
        case 'togglePlayback':
            API('togglePlayback');
            break
        case 'allowplayback':
            API('allowplayback');
            break
        case 'next':
            API('next');
            break
        case 'previous':
            API('previous');
            break
        case 'pause':
            API('pause');
            break
        case 'play':
            API('play');
            break
        }
    });

    document.addEventListener("autopause_result", e => {
	    switch(e.detail) {
            case 'play':
                send('play');
                break
            case 'playMuted':
                send('playMuted')
                break
            case 'pause':
                send('pause');
                break
	    }
    });

    function injectScript(filePath) {
        var script = document.createElement('script');
        script.setAttribute('type', 'text/javascript');
        script.setAttribute('crossorigin', 'anonymous');
        script.setAttribute('src', chrome.runtime.getURL(filePath));
        try {
            document.head.appendChild(script);
        } catch (e) {
            // May be blocked by CSP.
        }
    }
    
    function send(message) {
	    chrome.runtime.sendMessage(message);
    }
    
    window.addEventListener('DOMContentLoaded', () => {
        // Adds content to DOM needed because of isolation
        injectScript('WindowScript.js');
    }, {
        passive: true
    });

    window.addEventListener('pagehide', () => {
        send('pause');
    }, {
        passive: true
    });

    function checkVisibility() {
        if (document.visibilityState == 'hidden' && !document.pictureInPictureElement) {
		send('hidden');
	}
    }

    window.addEventListener('visibilitychange', checkVisibility, {
        capture: true,
        passive: true
    });
    
    // End of code
})();
