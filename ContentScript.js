'use strict';
/* global chrome */

(() => {
    // Script should only run once

    if (hasProperty(window, 'Elements')) return
    
    var Targets = new Set();
    
    var Elements = new Map();
    
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {
        case 'visablePopup':
            if (!visablePopup()) break
            sendResponse('true');
            break
        case 'toggleFastPlayback':
            toggleRate();
            break
        case 'Rewind':
            Rewind();
            break
        case 'allowplayback':
            resume(false);
            break
        case 'next':
            next();
            break
        case 'previous':
            previous();
            break
        case 'pause':
            pause();
            break
        case 'play':
            // When there media already playing tell the background script.
            if (isPlaying())
                send('play');
            resume(true);
            break
        case 'audible':
            send('imfinem8');
            checkShadow();
            break
        case 'hidden':
            checkVisibility();
            break
        case 'isplaying':
            if (!isPlaying()) break
            sendResponse('true');
            break
        case 'pauseOther':
            pauseOther(message.body);
            break
        case 'new':
            pageScript();
            checkShadow();
            checkDOM();
            break
        }
    });

    function isPlaying() {
        checkShadow();
        const audibleElements = [...Elements].filter((e, data) => !isMuted(e[0]));
        return (audibleElements.length !== 0);
    }

    function isPaused(e) {
        return (e.paused || e.playbackRate === 0);
    }

    function next() {
        Elements.forEach((data, e) => {
            if (isPaused(e)) return;
            e.currentTime = e.duration;
        });
    }

    function previous() {
        Elements.forEach((data, e) => {
            if (isPaused(e)) return;
            // Unknown
            e.currentTime = 0;
        });
    }

    // Controlled by global fast forward shortcut
    function toggleRate() {
        Elements.forEach((data, e) => {
            if (isPaused(e))
                return;
            if (e.playbackRate > 1) {
                e.playbackRate = 1;
            } else {
                e.playbackRate = 2;
            }
        });
    }
	
    function pauseOther(id) {
	Elements.forEach((data, e) => {
		if (e.paused || isMuted(e)) return;
		if (data.id !== id) e.pause();
        });
    }

    // Controlled by global rewind shortcut
    function Rewind() {
        Elements.forEach((data, e) => {
            if (isPaused(e))
                return;
            e.currentTime -= 30;
        });
    }
    
    function onPlay(e) {
	let data = Elements.get(e);
        if (isMuted(e)) {
            send('playMuted');
        } else {
            send('play', data.id);
        }
    }

    function addListener(src) {
        if (Targets.has(src)) return
        Targets.add(src);
        // On media play event
        src.addEventListener('play', function (event) {
            if (event.srcElement instanceof HTMLMediaElement) {
                addMedia(event.srcElement);
                onPlay(event.srcElement);
            }
        }, {
            capture: true,
            passive: true
        });
    }
	
    function isMuted(e) {
        if (e.muted) return true
        if (Elements.has(e)) {
            let data = Elements.get(e);
            if (data.wasPlaying) {
                return (data.wasVolume === 0)
            }
        }
        return (e.volume === 0);
    }
	
    function addMedia(src) {
        if (Elements.has(src)) return
	
	let mediaID = '';
	try {
	    mediaID = crypto.randomUUID();
	} catch {
	    // On insecure website we cant have a ID :(
	}
	
        Elements.set(src, {id: mediaID});
        let controller = new AbortController();
        
        src.addEventListener('volumechange', async  event => {
            if (event.srcElement instanceof HTMLMediaElement && !isPaused(event.srcElement)) {
                if (isMuted(event.srcElement)) await sleep(200);
                onPlay(event.srcElement);
            }
        }, {
            signal: controller.signal,
            capture: true,
            passive: true
        });
        
        src.addEventListener('pause', async event => {
            let src = event.srcElement;
            await sleep(200);
            onPause(src, controller);
        }, {
            signal: controller.signal,
            capture: true,
            passive: true
        });
        
        src.addEventListener('abort', event => {
            onPause(event.srcElement, controller);
        }, {
            signal: controller.signal,
            capture: true,
            passive: true
        });
        
        // Dont tell the media please
        src.addEventListener('ratechange', function (event) {
            if (event.srcElement instanceof HTMLMediaElement) {
                let data = Elements.has(event.srcElement) ? Elements.get(event.srcElement) : {};
                if (event.srcElement.playbackRate === 0 && data.wasPlaying) {
                    event.stopPropagation();
                }
                if (!isPaused(event.srcElement)) {
                    onPlay(event.srcElement);
                }
            }
        }, {
            signal: controller.signal,
            capture: true
        });
    }
    
    addListener(document);

    function onPause(src, controller) {
        if (src instanceof HTMLMediaElement && src.paused) {
            controller.abort();
            normalPlayback(src);
            Elements.delete(src);
            // Check if all elements have paused.
            if (!isPlaying()) {
                send('pause');
            }
        }
    }

    function normalPlayback(src) {
        let data = Elements.has(src) ? Elements.get(src) : {};
        if (data.wasPlaying) {
            src.volume = data.wasVolume;
            src.playbackRate = data.wasPlaybackRate;
            data.wasPlaying = false;
        }
    }

    function pauseElement(e, data) {
        // If media attempts to play when it should be paused dont change its old values.
        if (!data.wasPlaying) {
            data.wasVolume = e.volume;
            data.wasPlaybackRate = e.playbackRate;
        }
        // Rate change event will stopPropagation.
        data.wasPlaying = true;
        e.playbackRate = 0;
        e.volume = 0;
        Elements.set(e, data);
    }

    async function pause() {
        Elements.forEach((data, e) => {
            if (isPaused(e)) return;
            pauseElement(e, data);
        });
    }

    async function resume(shouldPlay) {
        Elements.forEach((data, e) => {
            if (!data.wasPlaying) return
            // Pause foreground media normaly
            if (shouldPlay === false)
                e.pause();
            normalPlayback(e);
        });
    }
    
    function checkShadow(DOM = document) {
        [...DOM.querySelectorAll('*')].map(e => {
            if (e instanceof HTMLElement) {
                let shadowDOM = shadow(e);
                if (shadowDOM !== null) {
                    checkShadow(shadowDOM);
                    addListener(shadowDOM);
                    [...shadowDOM.querySelectorAll('*')].map(e => {
                        if (!isPaused(e)) {
                            if (e instanceof HTMLMediaElement) {
                                addMedia(e);
                                onPlay(e);
                            }
                        }
                    });
                }
            }
        });
    }
	
    function checkDOM() {
        [...document.querySelectorAll('*')].map(e => {
            if (!isPaused(e)) {
                if (e instanceof HTMLMediaElement) {
                    addMedia(e);
                    onPlay(e);
                }
            }
        });
    }
    
    function send(message, body = '') {
        chrome.runtime.sendMessage({type: message, body: body, userActivation: navigator.userActivation.isActive});
    }
  
    let injected = false;

    function pageScript() {
        if (injected) return
        injected = true;
        // Adds content to DOM needed because of isolation
	send('injectScript');
    }
  
    window.addEventListener('DOMContentLoaded', () => {
      pageScript();
    }, {
        passive: true
    });

    window.addEventListener('pagehide', () => {
        send('pause');
    }, {
        passive: true
    });

    function visablePopup() {
        if (window.documentPictureInPicture) {
         if (documentPictureInPicture.window !== null) return true;
        }
        return (document.visibilityState !== 'hidden' || document.pictureInPictureElement);
    }

    function checkVisibility() {
        if (!visablePopup()) {
          checkShadow();
          send('hidden');	
        }
    }

    window.addEventListener('visibilitychange', checkVisibility, {
        capture: true,
        passive: true
    });
    
    function hasProperty(value, key) {
        return Object.prototype.hasOwnProperty.call(value, key);
    }

    function shadow(e) {
        if ('openOrClosedShadowRoot' in e) {
            return e.openOrClosedShadowRoot;
        } else {
            return chrome.dom.openOrClosedShadowRoot(e);
        }
    }
    
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    // End of code
})();
