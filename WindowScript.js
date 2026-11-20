// Security: Code here is exposed to the website.
// Notify ContentScript about detached media elements without mutating the DOM.
(function () {
  'use strict';

  // This is okay because the HTMLMediaElement prototype gets hooked.
  // Note to self: DO NOT CHANGE NAME
  if (window.autoPauseExtensionInjected) return;
  window.autoPauseExtensionInjected = true;

  const MediaElement = window.HTMLMediaElement;
  const play = MediaElement.prototype.play;
  const FocusEventCtor = window.FocusEvent;
  const dispatchEvent = window.EventTarget.prototype.dispatchEvent;
  const getIsConnected = Object.getOwnPropertyDescriptor(
    window.Node.prototype,
    'isConnected'
  )?.get;
  const doc = document;

  MediaElement.prototype.play = function () {
    try {
      if (
        this instanceof MediaElement &&
        !(getIsConnected ? getIsConnected.call(this) : this.isConnected)
      ) {
        dispatchEvent.call(
          doc,
          new FocusEventCtor('autoPauseMedia', {
            relatedTarget: this,
            bubbles: false,
            cancelable: false,
            composed: false
          })
        );
      }
    } catch {
      // Extension errors should not affect the API.
    }
    return play.apply(this, arguments);
  };
})();
