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
  'ignoreshort',
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

const matchPatternRegex =
  /^(https?|file|ftp|\*):\/\/(\*|\*\.[^*/]+|[^*/]+)\/.*$/;

function filterValidPatterns(patterns) {
  return patterns.filter(
    (domain) =>
      typeof domain === 'string' &&
      (domain === '<all_urls>' || matchPatternRegex.test(domain))
  );
}

// Security: Storage areas are restricted to trusted contexts where supported
// (Chrome 140+), but older Chrome and Firefox still expose sync to content scripts.
chrome.storage.sync.get(['options', 'exclude'], (result) => {
  if (
    typeof result.options === 'object' &&
    result.options !== null &&
    !Array.isArray(result.options)
  ) {
    options = result.options;
    applyChanges();
  }
  if (Array.isArray(result.exclude)) {
    exclude.value = filterValidPatterns(result.exclude).join(' ');
  }
});

chrome.storage.onChanged.addListener((result, areaName) => {
  if (areaName !== 'sync') return;
  if (
    typeof result.options?.newValue === 'object' &&
    result.options.newValue !== null &&
    !Array.isArray(result.options.newValue)
  ) {
    options = result.options.newValue;
    applyChanges();
  }
  if (Array.isArray(result.exclude?.newValue)) {
    exclude.value = filterValidPatterns(result.exclude.newValue).join(' ');
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
  ['picarto', 'https://picarto.tv/*'],
  ['meet', 'https://meet.google.com/*'],
  ['discord', 'https://discord.com/*'],
  ['zoom', 'https://*.zoom.us/*'],
  ['teams', 'https://teams.live.com/*'],
  ['messenger', 'https://www.messenger.com/*'],
  ['whatsapp', 'https://web.whatsapp.com/*'],
  ['twitter', 'https://x.com/*'],
  ['facebook', 'https://www.facebook.com/*']
]);

function autoComplete(e) {
  e.oninput = () => {
    let result = e.value.split(' ');
    for (let [index, value] of result.entries()) {
      const key = value.toLowerCase();
      if (common.has(key)) {
        result[index] = common.get(key);
      }
    }
    e.value = result.join(' ');
  };
}

autoComplete(userinput);
autoComplete(exclude);

async function permissionUpdate() {
  const domains = userinput.value.split(' ');

  const add = filterValidPatterns(domains);
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

  const newExclude = filterValidPatterns(exclude.value.split(' '));
  chrome.storage.sync.set({exclude: newExclude});
  exclude.value = newExclude.join(' ');
}
