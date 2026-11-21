// Security: Code here is exposed to the website.
// Notify ContentScript about detached media elements without mutating the DOM.
(function () {
  'use strict';

  // This is okay because the HTMLMediaElement prototype gets hooked.
  // Note to self: DO NOT CHANGE NAME
  if (window.autoPauseExtensionInjected) return;
  window.autoPauseExtensionInjected = true;

  const MediaElement = window.HTMLMediaElement;
  const FocusEventCtor = window.FocusEvent;
  const dispatchEvent = window.EventTarget?.prototype?.dispatchEvent;
  if (
    typeof MediaElement?.prototype?.play !== 'function' ||
    typeof FocusEventCtor !== 'function' ||
    typeof dispatchEvent !== 'function'
  ) {
    return;
  }
  const play = MediaElement.prototype.play;
  const getMediaPaused = Object.getOwnPropertyDescriptor(
    MediaElement.prototype,
    'paused'
  )?.get;
  const nodeProto = window.Node?.prototype || {};
  const getIsConnected = Object.getOwnPropertyDescriptor(
    nodeProto,
    'isConnected'
  )?.get;
  const getOwnerDocument = Object.getOwnPropertyDescriptor(
    nodeProto,
    'ownerDocument'
  )?.get;
  const getRootNode =
    typeof nodeProto.getRootNode === 'function' ? nodeProto.getRootNode : null;
  const doc = document;

  MediaElement.prototype.play = function () {
    try {
      if (
        typeof getMediaPaused === 'function' &&
        typeof getMediaPaused.call(this) === 'boolean'
      ) {
        const connected = getIsConnected
          ? getIsConnected.call(this)
          : this.isConnected;
        const ownerDoc = getOwnerDocument
          ? getOwnerDocument.call(this)
          : this.ownerDocument;
        const inShadow =
          connected &&
          getRootNode &&
          ownerDoc &&
          getRootNode.call(this) !== ownerDoc;
        if (!connected || inShadow) {
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
      }
    } catch {
      // Extension errors should not affect the API.
    }
    return play.apply(this, arguments);
  };
})();
