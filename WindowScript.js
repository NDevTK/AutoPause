// Security: Code here is exposed to the website.
// Hand detached media elements to the content script without changing the DOM.
(function () {
  'use strict';

  // This is okay because the HTMLMediaElement prototype gets hooked.
  // Note to self: DO NOT CHANGE NAME
  if (window.autoPauseExtensionInjected) return;
  window.autoPauseExtensionInjected = true;

  const play = window.HTMLMediaElement.prototype.play;
  const dispatchEvent = window.EventTarget.prototype.dispatchEvent;
  const MouseEvent = window.MouseEvent;
  window.HTMLMediaElement.prototype.play = function () {
    try {
      if (this instanceof HTMLMediaElement && !this.isConnected) {
        // relatedTarget passes the element reference to the content script's isolated world.
        dispatchEvent.call(
          window,
          new MouseEvent('autopause-media', {relatedTarget: this})
        );
      }
    } catch {
      // Extension errors should not affect the API.
    }
    return play.apply(this, arguments);
  };
})();
