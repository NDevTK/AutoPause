"use strict";
var permissions = [];
var options = {};

window.addEventListener("keyup", function(event) {
    if (event.keyCode === 13) {
        event.preventDefault();
        permissionUpdate();
    }
});

chrome.permissions.onAdded.addListener(getPermissions);
chrome.permissions.onRemoved.addListener(getPermissions);

chrome.storage.sync.get("options", function(result) {
    if (typeof result["options"] === 'object' && result["options"] !== null) options = result["options"];
    for (var key in options) {
        setState(key, options[key]);
    }
});

chrome.storage.onChanged.addListener(function(changes, namespace) {
    for (var key in changes) {
        setState(key, options[key].newValue);
    }
});


function setState(key, value) {
    if(typeof value !== "boolean") return
    switch(key) {
        case: "disableresume":
            disableresume.checked = value;
            return
        case: "pauseoninactive":
            pauseoninactive.checked = value;
            return
    }
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
