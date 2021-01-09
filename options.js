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
});

chrome.storage.onChanged.addListener(function(changes, namespace) {
    for (var key in changes) {
        options[key] = changes[key].newValue;
    }
});

function save() {
    chrome.storage.sync.set({options}, function(result) {});
}

disableresume.onclick = _ => {
    options.disableresume = disableresume.checked;
    save();
}

pauseoninactive.onclick = _ => {
    options.pauseoninactive = pauseoninactive.checked;
    save();
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
