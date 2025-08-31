'use strict';
/* global chrome */
var permissions = [];
var options = {};

// ID for each checkbox
const supported = [
  'disableresume',
  'pauseoninactive',
  'multipletabs',
  'ignoretabchange',
  'muteonpause',
  'ignoreother',
  'nopermission',
  'permediapause',
  'checkidle',
  'resumelimit',
  'allowactive',
  'ask',
  'noauto'
];

var userinput = document.getElementById('userinput');
var exclude = document.getElementById('exclude');

// User presses enter
window.addEventListener('keyup', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    permissionUpdate();
  }
});

chrome.permissions.onAdded.addListener(getPermissions);
chrome.permissions.onRemoved.addListener(getPermissions);

// Security: chrome.storage.sync is not safe from website content scripts.
chrome.storage.sync.get(['options', 'exclude'], (result) => {
  if (typeof result.options === 'object' && result.options !== null) {
    options = result.options;
    applyChanges();
  }
  if (Array.isArray(result.exclude)) {
    exclude.value = result.exclude.join(' ');
  }
});

chrome.storage.onChanged.addListener((result) => {
  if (typeof result.options === 'object' && result.options !== null) {
    options = result.options.newValue;
    applyChanges();
  }
});

function applyChanges() {
  supported.forEach((id) => {
    var state = hasProperty(options, id);
    document.getElementById(id).checked = state;
  });
}

supported.forEach((id) => {
  document.getElementById(id).onclick = () => {
    toggleOption(id);
  };
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
  return new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        options
      },
      function (result) {
        resolve(result);
      }
    );
  });
}

function getPermissions() {
  chrome.permissions.getAll((resp) => {
    permissions = resp.origins;
    userinput.value = permissions.join(' ');
  });
}

getPermissions();

const common = new Map([
  ['youtube', 'https://www.youtube.com/*'],
  ['soundcloud', 'https://soundcloud.com/*'],
  ['twitch', 'https://www.twitch.tv/*'],
  ['pandora', 'https://*.pandora.com/*'],
  ['wrif', 'https://wrif.com/*'],
  ['ustvgo', 'https://ustvgo.tv/*'],
  ['picarto', 'https://picarto.tv/*']
]);

userinput.oninput = () => {
  let result = userinput.value.split(' ');
  for (let [index, value] of result.entries()) {
    const key = value.toLowerCase();
    if (common.has(key)) {
      result[index] = common.get(key);
    }
  }
  userinput.value = result.join(' ');
};

async function permissionUpdate() {
  const domains = userinput.value.split(' ');
  const regex = /^(https?|file|ftp|\*):\/\/(\*|\*\.[^*/]+|[^*/]+)\/.*$/;

  const add = domains.filter(
    (domain) => domain === '<all_urls>' || regex.test(domain)
  );
  const remove = permissions.filter(
    (permission) => !domains.includes(permission)
  );

  if (remove.length > 0) {
    chrome.permissions.remove(
      {
        origins: remove
      },
      () => {
        getPermissions();
      }
    );
  }
  // Security: Maybe discourage the usage of <all_urls>
  if (add.length > 0) {
    chrome.permissions.request(
      {
        origins: add
      },
      () => {
        getPermissions();
      }
    );
  }
  chrome.storage.sync.set({
    exclude: exclude.value.split(' ').filter((domain) => domain)
  });
}
