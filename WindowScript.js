// Code here is exposed to the website.
// Automaticly add media elements to DOM.
(function() {
    "use strict";
    const play = window.HTMLMediaElement.prototype.play;
    let div = null;
    window.HTMLMediaElement.prototype.play = function() {
        let result = play.apply(this, arguments);
        if (this instanceof HTMLMediaElement === false) return result
        if (!document.contains(this)) {
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
                }, true);
            }
            div.appendChild(this);
        }
        return result
    }
})();
