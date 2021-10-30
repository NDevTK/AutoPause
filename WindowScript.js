// Code here is exposed to the website.
(function() {
  'use strict';
  const play = window.HTMLMediaElement.prototype.play;
  window.HTMLMediaElement.prototype.play = function() {
    if (this instanceof HTMLMediaElement) {
      addListener(this);
    }
    return play.apply(this, arguments);
  }

    var Elements = new Map();
    addListener(document);

    document.addEventListener("autopause_action", message => {
        switch (message.detail) {
        case 'toggleFastPlayback':
            toggleRate();
            break
        case 'Rewind':
            Rewind();
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
        Elements.forEach((data, e) => {
            if (e.paused) return;
            if (data.togglePause) {
                data.togglePause = false;
                e.playbackRate = data.wasPlaybackRate;
            } else {
                data.togglePause = true;
                data.wasPlaying = false;
                data.wasPlaybackRate = e.playbackRate;
                e.playbackRate = 0;
            }
            Elements.set(e, data);
        });
    }

    function isPlaying() {
        const audibleElements = [...Elements].filter((data, e) => !e.muted);
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
            if (data.wasPlaybackRate && e.playbackRate > 1) {
                e.playbackRate = data.wasPlaybackRate;
            } else {
                data.wasPlaybackRate = e.playbackRate;
                Elements.set(e, data);
                e.playbackRate = 2;
            }
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

    
    function onPlay(e, trusted = false) {
        if (e.muted) {
            send('playMuted');
        } else if (trusted) {   
            send('playTrusted');
            normalPlayback(e);
        } else {
            send('play');
        }
    }

    function send(message) {
	    document.dispatchEvent(new CustomEvent("autopause_result", {detail: message}));
    }
    
    function addListener(target) {
    let controller = new AbortController();
    // On media play event
    target.addEventListener('play', function (event) {
        const src = event.srcElement;
        if (src instanceof HTMLMediaElement) {
            Elements.set(src, {});
            onPlay(src, event.isTrusted);
        }
    }, {
        signal: controller.signal,
        capture: true,
        passive: true
    });

    target.addEventListener('volumechange', function (event) {
        const src = event.srcElement;
        if (src instanceof HTMLMediaElement && !isPaused(src)) {
            onPlay(src);
        }
    }, {
        signal: controller.signal,
        capture: true,
        passive: true
    });

    target.addEventListener('pause', event => {
        setTimeout(() => {
            onPause(event);
        }, 200);
    }, {
        signal: controller.signal,
        capture: true,
        passive: true
    });

    target.addEventListener('abort', event => {
        onPause(event);
    }, {
        signal: controller.signal,
        capture: true,
        passive: true
    });

    // Dont tell the media please
    target.addEventListener('ratechange', function (event) {
        const src = event.srcElement;
        if (src instanceof HTMLMediaElement) {
            let data = Elements.has(src) ? Elements.get(src) : {};
            if (src.playbackRate === 0 && data.wasPlaying) {
                event.stopPropagation();
            }
            if (!isPaused(src)) {
                onPlay(src);
            }
        }
    }, {
        signal: controller.signal,
        capture: true
    });
    }
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
})();
