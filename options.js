"use strict";
/*global chrome*/
var permissions = [];
var options = {};

// ID for each checkbox
const supported = ["disableresume", "pauseoninactive", "multipletabs"];

// User presses enter
window.addEventListener("keyup", function(event) {
    if (event.keyCode === 13) {
        event.preventDefault();
        permissionUpdate();
    }
});

chrome.permissions.onAdded.addListener(getPermissions);
chrome.permissions.onRemoved.addListener(getPermissions);

chrome.storage.sync.get("options", function(result) {
    if (typeof result["options"] === 'object' && result["options"] !== null) {
        options = result["options"];
        applyChanges();
    }
});

chrome.storage.onChanged.addListener(function(changes, namespace) {
    if (changes.hasOwnProperty("options")) {
        options = changes["options"].newValue;
        applyChanges();
    }
});


function applyChanges() {
    supported.forEach(id => {
        var state = options.hasOwnProperty(id);
        document.getElementById(id).checked = state;
    });
}

supported.forEach(id => {
    document.getElementById(id).onclick = _ => {
        toggleOption(id);
    }
});

function toggleOption(o) {
    if (options.hasOwnProperty(o)) {
        delete options[o];
    } else {
        options[o] = true;
    }
    return new Promise(resolve => {
        chrome.storage.sync.set({
            options
        }, function(result) {
            resolve(result);
        });
    });
}

function getPermissions() {
    chrome.permissions.getAll(resp => {
        permissions = resp.origins;
        userinput.value = permissions.join(" ");
    });
}

getPermissions();

async function permissionUpdate() {
    var domains = userinput.value.split(" ");

    var add = [];
    var remove = [];
    var regex = /^(https?|file|ftp|\*):\/\/(\*|\*\.[^*/]+|[^*/]+)\/.*$/;


    add = domains.filter(domain => domain === "<all_urls>" || regex.test(domain));
    remove = permissions.filter(permission => !domains.includes(permission));

    if (remove.length > 0) {
        chrome.permissions.remove({
            origins: remove
        }, function(removed) {
            getPermissions();
        });
    }

    if (add.length > 0) {
        chrome.permissions.request({
            origins: add
        }, function(result) {
            getPermissions();
        });
    }
}
