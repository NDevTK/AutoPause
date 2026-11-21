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

var permissionsForm = document.getElementById('permissions-form');
var userinput = document.getElementById('userinput');
var exclude = document.getElementById('exclude');
var allowAllBtn = document.getElementById('allow-all');
var statusEl = document.getElementById('permissions-status');

chrome.permissions.onAdded.addListener(getPermissions);
chrome.permissions.onRemoved.addListener(getPermissions);

const matchPatternRegex =
  /^(?:(https?|ftp|\*):\/\/(\*|(?:\*\.)?[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)|file:\/\/[^*/:\s]*)\/.*$/;
const bareHostRegex = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const schemeNoPathRegex = /^(?:https?|ftp|\*):\/\/[^/\s]+$/;
const schemeTrailingSlashRegex = /^(?:https?|ftp|\*):\/\/[^/\s]+\/$/;

function filterValidPatterns(patterns) {
  return patterns.filter(
    (domain) =>
      typeof domain === 'string' &&
      (domain === '<all_urls>' || matchPatternRegex.test(domain))
  );
}

const common = new Map([
  ['youtube', 'https://*.youtube.com/*'],
  ['spotify', 'https://open.spotify.com/*'],
  ['soundcloud', 'https://soundcloud.com/*'],
  ['twitch', 'https://www.twitch.tv/*'],
  ['netflix', 'https://*.netflix.com/*'],
  ['vimeo', 'https://vimeo.com/*'],
  ['reddit', 'https://*.reddit.com/*'],
  ['pandora', 'https://*.pandora.com/*'],
  ['bandcamp', 'https://*.bandcamp.com/*'],
  ['tiktok', 'https://www.tiktok.com/*'],
  ['instagram', 'https://www.instagram.com/*'],
  ['picarto', 'https://picarto.tv/*'],
  ['meet', 'https://meet.google.com/*'],
  ['discord', 'https://discord.com/*'],
  ['zoom', 'https://*.zoom.us/*'],
  ['teams', 'https://teams.live.com/*'],
  ['messenger', 'https://www.messenger.com/*'],
  ['whatsapp', 'https://web.whatsapp.com/*'],
  ['twitter', 'https://x.com/*'],
  ['x', 'https://x.com/*'],
  ['facebook', 'https://www.facebook.com/*']
]);

function normalizeEntry(raw) {
  const entry = raw.trim();
  if (!entry) return null;
  if (entry === '<all_urls>') return '<all_urls>';
  const lower = entry.toLowerCase();
  if (common.has(lower)) return common.get(lower);
  if (matchPatternRegex.test(entry)) return entry;
  if (schemeNoPathRegex.test(entry)) {
    const candidate = entry + '/*';
    if (matchPatternRegex.test(candidate)) return candidate;
  }
  if (schemeTrailingSlashRegex.test(entry)) {
    const candidate = entry + '*';
    if (matchPatternRegex.test(candidate)) return candidate;
  }
  const stripped = lower.endsWith('/') ? lower.slice(0, -1) : lower;
  if (bareHostRegex.test(stripped)) {
    const candidate =
      stripped.startsWith('*.') || stripped.split('.').length > 2
        ? `https://${stripped}/*`
        : `https://*.${stripped}/*`;
    if (matchPatternRegex.test(candidate)) return candidate;
  }
  return null;
}

function parseEntries(value) {
  const tokens = value.trim() ? value.trim().split(/\s+/) : [];
  const valid = [];
  const seen = new Set();
  const invalid = [];
  for (const token of tokens) {
    const normalized = normalizeEntry(token);
    if (normalized) {
      if (!seen.has(normalized)) {
        seen.add(normalized);
        valid.push(normalized);
      }
    } else {
      invalid.push(token);
    }
  }
  return {valid, invalid};
}

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = isError ? 'status error' : 'status';
}

function clearFieldValidity(input) {
  input.classList.remove('is-invalid');
  input.setCustomValidity('');
  if (statusEl?.classList.contains('error')) setStatus('');
}

userinput.addEventListener('input', () => clearFieldValidity(userinput));
exclude.addEventListener('input', () => clearFieldValidity(exclude));

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

function updateOptionStates() {
  document.querySelectorAll('.option[data-dim-when]').forEach((row) => {
    const keys = row.dataset.dimWhen.split(' ');
    const overridden = keys.some((key) => hasProperty(options, key));
    row.classList.toggle('is-dimmed', overridden);
  });
}

function applyChanges() {
  supported.forEach((id) => {
    var state = hasProperty(options, id);
    document.getElementById(id).checked = state;
  });
  updateOptionStates();
}

supported.forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    toggleOption(id);
  });
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
  updateOptionStates();
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

function updateAllowAllButton() {
  if (!allowAllBtn) return;
  const hasAll = permissions.includes('<all_urls>');
  allowAllBtn.disabled = hasAll;
  allowAllBtn.textContent = hasAll ? 'All sites enabled' : 'Allow all sites';
}

function getPermissions() {
  chrome.permissions.getAll((resp) => {
    permissions = Array.isArray(resp?.origins) ? resp.origins : [];
    userinput.value = permissions.join(' ');
    updateAllowAllButton();
  });
}

getPermissions();

if (allowAllBtn) {
  allowAllBtn.addEventListener('click', () => {
    if (permissions.includes('<all_urls>')) {
      setStatus('Already enabled on all sites.');
      return;
    }
    chrome.permissions.request({origins: ['<all_urls>']}, (granted) => {
      if (chrome.runtime.lastError) {
        setStatus('Could not request all-sites permission.', true);
        return;
      }
      getPermissions();
      setStatus(
        granted ? 'Enabled on all sites.' : 'Permission request canceled.',
        !granted
      );
    });
  });
}

function permissionUpdate(event) {
  if (event) event.preventDefault();

  const parsedAllow = parseEntries(userinput.value);
  const parsedExclude = parseEntries(exclude.value);

  const allowInvalid = parsedAllow.invalid.length > 0;
  const excludeInvalid = parsedExclude.invalid.length > 0;

  userinput.classList.toggle('is-invalid', allowInvalid);
  userinput.setCustomValidity(allowInvalid ? 'Invalid site pattern' : '');
  exclude.classList.toggle('is-invalid', excludeInvalid);
  exclude.setCustomValidity(excludeInvalid ? 'Invalid site pattern' : '');

  if (allowInvalid || excludeInvalid) {
    const bad = parsedAllow.invalid.concat(parsedExclude.invalid).join(', ');
    setStatus(
      `Invalid site pattern: ${bad}. Use a domain like spotify.com or https://*.example.com/*`,
      true
    );
    return;
  }

  userinput.value = parsedAllow.valid.join(' ');
  exclude.value = parsedExclude.valid.join(' ');

  const add = parsedAllow.valid.filter((p) => !permissions.includes(p));
  const remove = permissions.filter((p) => !parsedAllow.valid.includes(p));

  // Request new permissions synchronously inside the user gesture handler (required in Firefox).
  if (add.length > 0) {
    chrome.permissions.request({origins: add}, (granted) => {
      if (chrome.runtime.lastError) {
        setStatus('Could not request one or more site permissions.', true);
        getPermissions();
        return;
      }
      getPermissions();
      setStatus(
        granted ? 'Saved.' : 'Permission request canceled.',
        !granted
      );
    });
  }

  if (remove.length > 0) {
    chrome.permissions.remove({origins: remove}, () => {
      void chrome.runtime.lastError;
      getPermissions();
      if (add.length === 0) setStatus('Saved.');
    });
  }

  chrome.storage.sync.set({exclude: parsedExclude.valid}, () => {
    void chrome.runtime.lastError;
    if (add.length === 0 && remove.length === 0) setStatus('Saved.');
  });
}

permissionsForm.addEventListener('submit', permissionUpdate);
