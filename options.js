'use strict';
/* global chrome */
var permissions = [];
var options = {};

// ID for each checkbox
const supported = ['disableresume', 'pauseoninactive', 'multipletabs', 'ignoretabchange', 'muteonpause', 'ignoreother', 'nopermission'];

var userinput = document.getElementById('userinput');

// User presses enter
window.addEventListener('keyup', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        permissionUpdate();
    }
});

chrome.permissions.onAdded.addListener(getPermissions);
chrome.permissions.onRemoved.addListener(getPermissions);

chrome.storage.sync.get('options', result => {
    if (typeof result.options === 'object' && result.options !== null) {
        options = result.options;
	applyChanges();
    }
});

chrome.storage.onChanged.addListener(result => {
    if (typeof result.options === 'object' && result.options !== null) {
        options = result.options.newValue;
	applyChanges();
    }
});

function applyChanges() {
    supported.forEach(id => {
        var state = hasProperty(options, id);
        document.getElementById(id).checked = state;
    });
}

supported.forEach(id => {
    document.getElementById(id).onclick = () => {
        toggleOption(id);
    }
});

function hasProperty(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function toggleOption(o) {
    if (hasProperty(options, o)) {
        delete options[o];
    } else {
        options[o] = true;
    }
    return new Promise(resolve => {
        chrome.storage.sync.set({
            options
        }, function (result) {
            resolve(result);
        });
    });
}

function getPermissions() {
    chrome.permissions.getAll(resp => {
        permissions = resp.origins;
        userinput.value = permissions.join(' ');
    });
}

getPermissions();

async function permissionUpdate() {
    const domains = userinput.value.split(' ');
    const regex = /^(https?|file|ftp|\*):\/\/(\*|\*\.[^*/]+|[^*/]+)\/.*$/;

    const add = domains.filter(domain => domain === '<all_urls>' || regex.test(domain));
    const remove = permissions.filter(permission => !domains.includes(permission));

    if (remove.length > 0) {
        chrome.permissions.remove({
            origins: remove
        }, () => {
            getPermissions();
        });
    }

    if (add.length > 0) {
        chrome.permissions.request({
            origins: add
        }, () => {
            getPermissions();
        });
    }
}


// datalist multiple support.
document.addEventListener("DOMContentLoaded", function () {
    const separator = ' ';

    for (const input of document.getElementsByTagName("input")) {
        if (!input.multiple) {
            continue;
        }

        if (input.list instanceof HTMLDataListElement) {
            const optionsValues = Array.from(input.list.options).map(opt => opt.value);
            let valueCount = input.value.split(separator).length;

            input.addEventListener("input", () => {
                const currentValueCount = input.value.split(separator).length;

                // Do not update list if the user doesn't add/remove a separator
                // Current value: "a, b, c"; New value: "a, b, cd" => Do not change the list
                // Current value: "a, b, c"; New value: "a, b, c," => Update the list
                // Current value: "a, b, c"; New value: "a, b" => Update the list
                if (valueCount !== currentValueCount) {
                    const lsIndex = input.value.lastIndexOf(separator);
                    const str = lsIndex !== -1 ? input.value.substr(0, lsIndex) + separator : "";
                    filldatalist(input, optionsValues, str);
                    valueCount = currentValueCount;
                }
            });
        }
    }

    function filldatalist(input: HTMLInputElement, optionValues: string[], optionPrefix: string) {
        const list = input.list;
        if (list && optionValues.length > 0) {
            list.innerHTML = "";

            const usedOptions = optionPrefix.split(separator).map(value => value.trim());

            for (const optionsValue of optionValues) {
                if (usedOptions.indexOf(optionsValue) < 0) { // Skip used values
                    const option = document.createElement("option");
                    option.value = optionPrefix + optionsValue;
                    list.append(option);
                }
            }
        }
    }
});
