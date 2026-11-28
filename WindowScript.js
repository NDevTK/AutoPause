// Security: Code here is exposed to the website.
// Hand media the content script can't see (detached or in a shadow root) to it without changing the DOM.
(function () {
  'use strict';

  // This is okay because the HTMLMediaElement prototype gets hooked.
  // Note to self: DO NOT CHANGE NAME
  if (window.autoPauseExtensionInjected) return;
  window.autoPauseExtensionInjected = true;

  const play = window.HTMLMediaElement.prototype.play;
  window.HTMLMediaElement.prototype.play = function () {
    try {
      // Detached or in a shadow root: play events won't reach the content script's document listener.
      if (
        this instanceof HTMLMediaElement &&
        this.getRootNode() !== this.ownerDocument
      ) {
        // relatedTarget passes the element reference to the content script's isolated world.
        window.dispatchEvent(
          new MouseEvent('autopauseextension-media', {relatedTarget: this})
        );
      }
    } catch {
      // Extension errors should not affect the API.
    }
    return play.apply(this, arguments);
  };
})();
