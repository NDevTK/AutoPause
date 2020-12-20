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
        if (resp.origins.length < 1) return;
        if (isChrome) {
            for (origin of ["http://*/*", "https://*/*", "*://*/*", "<all_urls>"]) {
                if (resp.origins.includes(origin)) {
                    userinput.value = 'Extension has acesss to all urls use the native "Site access" option to revoke this.';
                    userinput.disabled = true;
                    return
                }
            }
        }
        userinput.value = permissions.join(",");
    });
}

getPermissions();

function permissionUpdate() {
    var domains = userinput.value.split(",");

    var add = [];
    var remove = [];
    var regex = /^(https?|file|ftp|\*):\/\/(\*|\*\.[^*/]+|[^*/]+)\/.*$/;

    for (let domain of domains) {
        if (domain === "<all_urls>" || regex.test(domain)) {
            if (!permissions.includes(domain)) add.push(domain);
        }
    };

    for (let domain of permissions) {
        if (!domains.includes(domain)) remove.push(domain);
    }

    userinput.value = "";

    if (add.length > 0) {
        chrome.permissions.request({
            origins: add
        }, function(result) {});
    }

    if (remove.length > 0) {
        chrome.permissions.remove({
            origins: remove
        }, function(removed) {});
    }
}
