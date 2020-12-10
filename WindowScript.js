// Code here is exposed to the website.
// Automaticly add media elements to DOM.
(function() {
    "use strict";
    var play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
        let result = play.apply(this, arguments);
		if(!document.contains(this)) {
			this.hidden = true;
			document.body.appendChild(this);
		}
        return result
    }
})();
