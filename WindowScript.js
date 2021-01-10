// Code here is exposed to the website.
// Automaticly add media elements to DOM.
(function() {
    "use strict";
    const play = window.HTMLMediaElement.prototype.play;
    let div = null;
    window.HTMLMediaElement.prototype.play = function() {
        if (this instanceof HTMLMediaElement === false && !document.contains(this)) {
            if (!document.contains(div)) {
                div = document.createElement('div');
                div.hidden = true;
                document.head.appendChild(div);
                // If media gets paused remove it from the div
                div.addEventListener("pause", event => {
                    let src = event.srcElement;
                    if (src instanceof HTMLMediaElement) {
                        div.removeChild(src);
                    }
                }, {passive: true, capture: true});
            }
            div.appendChild(this);
        }
        return play.apply(this, arguments);
    }
})();
