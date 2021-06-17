'use strict';
/* global chrome */

(() => {
    // Script should only run once

    if (hasProperty(window, "Elements")) return
    
    var Elements = new Set();
    var State = null;
    var Visibility = null;
    
    chrome.runtime.onMessage.addListener(message => {
        switch (message) {
        case 'toggleFastPlayback':
            toggleRate();
            break
        case 'togglePlayback':
            togglePlayback();
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
        }
    });

    function hasProperty(value, key) {
        return Object.prototype.hasOwnProperty.call(value, key);
    }

    function togglePlayback() {
        Elements.forEach(e => {
            if (e.paused) return;
            if (e.togglePause) {
                e.togglePause = false;
                e.playbackRate = e.wasPlaybackRate;
            } else {
                e.togglePause = true;
                e.wasPlaying = false;
                e.wasPlaybackRate = e.playbackRate;
                e.playbackRate = 0;
            }
        });
    }

    function isPlaying() {
        const audibleElements = [...Elements].filter(e => !e.muted);
        return (audibleElements.length !== 0);
    }

    function isPaused(e) {
        return (e.paused || e.playbackRate === 0);
    }

    function next() {
        Elements.forEach(e => {
            if (isPaused(e)) return;
            e.currentTime = e.duration;
        });
    }

    function previous() {
        Elements.forEach(e => {
            if (isPaused(e)) return;
            // Unknown
            e.currentTime = 0;
        });
    }

    // Controlled by global fast forward shortcut
    function toggleRate() {
        Elements.forEach(e => {
            if (isPaused(e))
                return;
            if (e.wasPlaybackRate && e.playbackRate > 1) {
                e.playbackRate = e.wasPlaybackRate;
            } else {
                e.wasPlaybackRate = e.playbackRate;
                e.playbackRate = 2;
            }
        });
    }

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

    
    function onPlay(e, trusted = false) {
        if (e.muted) {
            send('playMuted');
        } else if (trusted) {
            send('playTrusted');
        } else {
            send('play');
        }
    }

    function send(message) {
        if (State !== message) {
            chrome.runtime.sendMessage(message);
            State = message;
        }
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

    // On media play event
    window.addEventListener('play', function (event) {
        const src = event.srcElement;
        if (src instanceof HTMLMediaElement) {
            onPlay(src, event.isTrusted);
            Elements.add(src);
        }
    }, {
        capture: true,
        passive: true
    });

    window.addEventListener('volumechange', function (event) {
        const src = event.srcElement;
        if (src instanceof HTMLMediaElement && !isPaused(src)) {
            onPlay(src, event.isTrusted);
        }
    }, {
        capture: true,
        passive: true
    });
    
    function checkVisibility() {
        let result;
        if (document.visibilityState == 'hidden' && !document.pictureInPictureElement) {
            result = "hidden";
        } else {
            result = "shown";
        }
        if (result !== Visibility) {
            Visibility = result;
            chrome.runtime.sendMessage(Visibility);
        }
    }
    
    window.addEventListener('visibilitychange', checkVisibility, {
        capture: true,
        passive: true
    });
    
    window.addEventListener('leavepictureinpicture', checkVisibility, {
        capture: true,
        passive: true
    });
    
    window.addEventListener('enterpictureinpicture', checkVisibility, {
        capture: true,
        passive: true
    });

    window.addEventListener('pause', event => {
        setTimeout(() => {
            onPause(event);
        }, 200);
    }, {
        capture: true,
        passive: true
    });

    window.addEventListener('abort', event => {
        onPause(event);
    }, {
        capture: true,
        passive: true
    });

    function onPause(event) {
        const src = event.srcElement;
        if (src instanceof HTMLMediaElement && src.paused) {
            // Check if all elements have paused.
            Elements.delete(src);
            normalPlayback(src);
            if (!isPlaying()) {
                send('pause');
            }
        }
    }

    function normalPlayback(src) {
        if (src.wasPlaying) {
            src.volume = src.wasVolume;
            src.playbackRate = src.wasPlaybackRate;
            src.wasPlaying = false;
        }
    }

    // Dont tell the media please
    window.addEventListener('ratechange', function (event) {
        const src = event.srcElement;
        if (src instanceof HTMLMediaElement) {
            if (src.playbackRate === 0 && src.wasPlaying) {
                event.stopPropagation();
            }
            if (!isPaused(src)) {
                onPlay(src, event.isTrusted);
            }
        }
    }, {
        capture: true
    });

    function pauseElement(e) {
        // If media attempts to play when it should be paused dont change its old values.
        if (!e.wasPlaying) {
            e.wasVolume = e.volume;
            e.wasPlaybackRate = e.playbackRate;
        }
        // Rate change event will stopPropagation.
        e.wasPlaying = true;
        e.playbackRate = 0;
        e.volume = 0;
    }

    async function pause() {
        Elements.forEach(e => {
            if (isPaused(e)) return;
            pauseElement(e);
        });
    }

    async function resume(shouldPlay) {
        Elements.forEach(e => {
            if (!document.contains(e)) {
                Elements.delete(e);
                return
            }
            if (!e.wasPlaying) return
            // Pause foreground media normaly
            if (shouldPlay === false)
                e.pause();
            normalPlayback(e);
        });
    }

    // End of code
})();
