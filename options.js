"use strict";
var permissions = [];
const isChrome = (typeof(browser) === "undefined");

window.addEventListener("keyup", function(event) {
    if (event.keyCode === 13) {
        event.preventDefault();
        permissionUpdate();
    }
});

chrome.permissions.onAdded.addListener(getPermissions);
chrome.permissions.onRemoved.addListener(getPermissions);

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

    for (let domain of domains) {
        if (domain === "<all_urls>" || regex.test(domain)) {
            add.push(domain);
        }
    };

    for (let domain of permissions) {
        if (!domains.includes(domain)) remove.push(domain);
    }

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
