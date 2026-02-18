// Security: Code here is exposed to the website.
// Automaticly add media elements to DOM.
(function () {
  'use strict';

  // This is okay because the HTMLMediaElement prototype gets hooked.
  // Note to self: DO NOT CHANGE NAME
  if (window.autoPauseExtensionInjected) return;
  window.autoPauseExtensionInjected = true;

  // Detect microphone usage for voice recording pause feature.
  if (
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  ) {
    const originalGetUserMedia =
      navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = function (constraints) {
      const result = originalGetUserMedia.apply(
        navigator.mediaDevices,
        arguments
      );
      try {
        if (constraints && constraints.audio) {
          result
            .then((stream) => {
              try {
                const audioTracks = stream.getAudioTracks();
                if (audioTracks.length === 0) return;
                document.dispatchEvent(
                  new CustomEvent('autopause-microphone-start')
                );
                let activeTracks = audioTracks.length;
                for (const track of audioTracks) {
                  track.addEventListener(
                    'ended',
                    () => {
                      activeTracks--;
                      if (activeTracks <= 0) {
                        document.dispatchEvent(
                          new CustomEvent('autopause-microphone-stop')
                        );
                      }
                    },
                    {once: true}
                  );
                }
              } catch {}
            })
            .catch(() => {});
        }
      } catch {}
      return result;
    };
  }

  const play = window.HTMLMediaElement.prototype.play;
  let div = null;
  window.HTMLMediaElement.prototype.play = function () {
    try {
      if (this instanceof HTMLMediaElement && !this.isConnected) {
        if (!document.contains(div)) {
          div = document.createElement('div');
          div.hidden = true;
          document.head.appendChild(div);
          // If media gets paused remove it from the div
          div.addEventListener(
            'pause',
            (event) => {
              const src = event.srcElement;
              if (src instanceof HTMLMediaElement) {
                div.removeChild(src);
              }
            },
            {passive: true, capture: true}
          );
        }
        div.appendChild(this);
      }
    } catch {
      // Extension errors should not affect the API.
    }
    return play.apply(this, arguments);
  };
})();
