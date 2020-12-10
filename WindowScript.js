// Code here is exposed to the website.
// Automaticly add media elements to DOM.
(function() {
    "use strict";
    var made = false;
    const play = HTMLMediaElement.prototype.play;

    HTMLMediaElement.prototype.play = function() {
        let result = play.apply(this, arguments);
        if (!document.contains(this)) {
            if (made === false) {
                const div = document.createElement('div');
                div.hidden = true;
                document.head.appendChild(div);
                made = true;
            }
            div.appendChild(this);
        }
        return result
    }
})();
