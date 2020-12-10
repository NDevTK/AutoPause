// Code here is exposed to the website.
// Automaticly add media elements to DOM.
(function() {
    "use strict";
    const play = HTMLMediaElement.prototype.play;
    var div;
    HTMLMediaElement.prototype.play = function() {
        let result = play.apply(this, arguments);
        if (!document.contains(this)) {
            if (!document.contains(div)) {
                div = document.createElement('div');
                div.hidden = true;
                document.head.appendChild(div);
            }
            div.appendChild(this);
        }
        return result
    }
})();
