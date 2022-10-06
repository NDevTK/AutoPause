// Code here is exposed to the website.
// Automaticly add media elements to DOM.
(function() {
  'use strict';
  const play = window.HTMLMediaElement.prototype.play;
  let div = null;
  window.HTMLMediaElement.prototype.play = function() {
    try {
      if (this instanceof HTMLMediaElement && !this.isConnected) {
        if (!document.contains(div)) {
          div = document.createElement('div');
          div.hidden = true;
          document.head.appendChild(div);
          // If media gets paused remove it from the div
          div.addEventListener('pause', event => {
            const src = event.srcElement;
            if (src instanceof HTMLMediaElement) {
              div.removeChild(src);
            }
          }, { passive: true, capture: true });
        }
        div.appendChild(this);
      }
    } catch {
      // Extension errors should not affect the API.
    }
    return play.apply(this, arguments);
  }
})();
