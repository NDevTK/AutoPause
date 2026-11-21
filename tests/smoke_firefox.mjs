'use strict';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIREFOX = process.env.FIREFOX_BIN || 'firefox';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const {port} = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function makeWav(seconds = 10, sampleRate = 8000, freq = 440) {
  const numSamples = seconds * sampleRate;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    buf.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 16000),
      44 + i * 2
    );
  }
  return buf;
}
const WAV_BUF = makeWav(10);

class BiDiClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const {resolve, reject} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.type === 'error')
          reject(new Error(`${msg.error}: ${msg.message}`));
        else resolve(msg.result);
      } else if (msg.type === 'event') {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.ws.send(JSON.stringify({id, method, params}));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }
  close() {
    this.ws?.close();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 12000, intervalMs = 150) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fn();
      if (res) return res;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw lastErr || new Error('Timed out waiting for condition');
}

function buildFirefoxExt(
  destDir,
  extraHostPermissions = null,
  openOptionsInTab = false
) {
  fs.rmSync(destDir, {recursive: true, force: true});
  fs.mkdirSync(destDir, {recursive: true});
  for (const name of fs.readdirSync(REPO)) {
    if (/\.(js|css|html|json|png)$/.test(name) || name === 'LICENSE') {
      if (name.includes('-chrome.') || name === 'icon.png') continue;
      let target = name;
      if (name === 'manifest-firefox.json') target = 'manifest.json';
      if (name === 'options-firefox.js') target = 'options-browser.js';
      fs.copyFileSync(path.join(REPO, name), path.join(destDir, target));
    }
  }
  if (extraHostPermissions || openOptionsInTab) {
    const mPath = path.join(destDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    if (extraHostPermissions) manifest.host_permissions = extraHostPermissions;
    if (openOptionsInTab) manifest.options_ui.open_in_tab = true;
    fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2));
  }
}

function readAddonUuid(profileDir, addonId) {
  const prefsPath = path.join(profileDir, 'prefs.js');
  if (!fs.existsSync(prefsPath)) return null;
  const txt = fs.readFileSync(prefsPath, 'utf8');
  const marker = 'user_pref("extensions.webextensions.uuids", ';
  const start = txt.indexOf(marker);
  if (start === -1) return null;
  const end = txt.indexOf(');', start + marker.length);
  if (end === -1) return null;
  const jsonString = JSON.parse(txt.slice(start + marker.length, end).trim());
  const map = JSON.parse(jsonString);
  return map[addonId] || null;
}

function deserializeBiDi(val) {
  if (!val) return undefined;
  switch (val.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'boolean':
    case 'number':
    case 'string':
      return val.value;
    case 'array':
      return val.value.map(deserializeBiDi);
    case 'object': {
      const obj = {};
      for (const [k, v] of val.value) obj[k] = deserializeBiDi(v);
      return obj;
    }
    default:
      return val.value;
  }
}

async function evalBiDi(
  bidi,
  context,
  expression,
  awaitPromise = true,
  userActivation = false
) {
  const res = await bidi.send('script.evaluate', {
    expression,
    target: {context},
    awaitPromise,
    userActivation
  });
  if (res.type === 'exception') {
    throw new Error(`BiDi exception: ${res.exceptionDetails.text}`);
  }
  return deserializeBiDi(res.result);
}

async function launchFirefox(profileDir, port) {
  fs.rmSync(profileDir, {recursive: true, force: true});
  fs.mkdirSync(profileDir, {recursive: true});
  fs.writeFileSync(
    path.join(profileDir, 'user.js'),
    [
      'user_pref("xpinstall.signatures.required", false);',
      'user_pref("media.autoplay.default", 0);',
      'user_pref("media.autoplay.blocking_policy", 0);',
      'user_pref("media.cubeb.force_mock_context", true);',
      'user_pref("media.cubeb.sandbox", false);',
      'user_pref("remote.active-protocols", 1);',
      'user_pref("browser.tabs.warnOnClose", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);'
    ].join('\n')
  );

  const ffArgs = [
    '--no-remote',
    '--profile',
    profileDir,
    `--remote-debugging-port=${port}`,
    'about:blank'
  ];
  const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
  const proc = spawn(
    useXvfb ? 'xvfb-run' : FIREFOX,
    useXvfb ? ['-a', FIREFOX, ...ffArgs] : ffArgs,
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1'}
    }
  );
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d.toString()));
  proc.stderr.on('data', (d) => (logs += d.toString()));

  await waitFor(
    () => logs.includes(`WebDriver BiDi listening on ws://127.0.0.1:${port}`),
    15000,
    150
  );

  const bidi = new BiDiClient(`ws://127.0.0.1:${port}/session`);
  await bidi.connect();
  await bidi.send('session.new', {
    capabilities: {alwaysMatch: {webSocketUrl: true}}
  });
  return {
    proc,
    bidi,
    getLogs: () => logs,
    async stop() {
      bidi.close();
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {}
      await sleep(200);
    }
  };
}

function startTestServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/tone.wav') {
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': WAV_BUF.length
      });
      res.end(WAV_BUF);
      return;
    }
    if (url.pathname === '/normal') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(`<!doctype html><html><body>
        <audio id="a" src="/tone.wav" loop></audio>
        <script>
          window._pageSawZeroVolume = 0;
          window._pageSawZeroRate = 0;
          window._captureLeakCount = 0;
          window._pageSawAutoPauseEvent = 0;
          window._muteEvents = [];
          window.addEventListener('autoPauseMedia', () => { window._pageSawAutoPauseEvent++; }, true);
          document.addEventListener('autoPauseMedia', () => { window._pageSawAutoPauseEvent++; }, true);
          const mainAudio = document.getElementById('a');
          for (const tgt of [window, document, document.body, mainAudio]) {
            tgt.addEventListener('volumechange', (e) => {
              if (e.target === mainAudio && mainAudio.volume === 0 && !mainAudio.muted && !window._allowZeroVolCapture) {
                window._captureLeakCount++;
              }
            }, true);
            tgt.addEventListener('ratechange', (e) => {
              if (e.target === mainAudio && mainAudio.playbackRate === 0) {
                window._captureLeakCount++;
              }
            }, true);
          }
          mainAudio.addEventListener('volumechange', () => {
            window._muteEvents.push({muted: mainAudio.muted, volume: mainAudio.volume});
            if (mainAudio.volume === 0) window._pageSawZeroVolume++;
          });
          mainAudio.addEventListener('ratechange', () => {
            if (mainAudio.playbackRate === 0) window._pageSawZeroRate++;
          });
          window.playAudio = () => mainAudio.play();
          window.pauseAudio = () => mainAudio.pause();
          window.testMuteUnmuteWhilePaused = async () => {
            window._muteEvents = [];
            window._allowZeroVolCapture = true;
            mainAudio.muted = true;
            await new Promise((r) => setTimeout(r, 80));
            mainAudio.muted = false;
            await new Promise((r) => setTimeout(r, 80));
            window._allowZeroVolCapture = false;
            return window._muteEvents.slice();
          };
          window.testOverlappingPauseDebounce = async () => {
            mainAudio.pause();
            await new Promise((r) => setTimeout(r, 50));
            await mainAudio.play();
            await new Promise((r) => setTimeout(r, 120));
            mainAudio.pause();
            await new Promise((r) => setTimeout(r, 60));
            await mainAudio.play();
            await new Promise((r) => setTimeout(r, 120));
            return {paused: mainAudio.paused, playbackRate: mainAudio.playbackRate};
          };
          window.startMutedMedia = async () => {
            const m = document.createElement('audio');
            m.src = '/tone.wav';
            m.loop = true;
            m.muted = true;
            m.volume = 0.8;
            document.body.appendChild(m);
            await m.play();
            await new Promise((r) => setTimeout(r, 80));
            window._mutedVolChanges = 0;
            m.addEventListener('volumechange', () => { window._mutedVolChanges++; });
            window._mutedMedia = m;
          };
          window.getMutedMediaState = () => ({
            paused: window._mutedMedia.paused,
            playbackRate: window._mutedMedia.playbackRate,
            volume: window._mutedMedia.volume,
            muted: window._mutedMedia.muted,
            volChanges: window._mutedVolChanges
          });
          window.stopMutedMedia = () => {
            window._mutedMedia.pause();
            window._mutedMedia.remove();
          };
          window.getAudioState = () => ({
            paused: mainAudio.paused,
            playbackRate: mainAudio.playbackRate,
            volume: mainAudio.volume,
            pageSawZeroVolume: window._pageSawZeroVolume,
            pageSawZeroRate: window._pageSawZeroRate,
            captureLeakCount: window._captureLeakCount
          });
          window.startDetachedMatrix = async () => {
            // 1. Standalone new Audio()
            const a1 = new Audio('/tone.wav');
            a1.loop = true;
            await a1.play();

            // 2. Detached div wrapper (never mounted)
            const wrap = document.createElement('div');
            const a2 = document.createElement('audio');
            a2.src = '/tone.wav';
            a2.loop = true;
            wrap.appendChild(a2);
            await a2.play();

            // 3. Detached DocumentFragment (never mounted)
            const frag = document.createDocumentFragment();
            const a3 = document.createElement('audio');
            a3.src = '/tone.wav';
            a3.loop = true;
            frag.appendChild(a3);
            await a3.play();

            // 4. Detached closed ShadowRoot (never mounted)
            const host = document.createElement('div');
            const sr = host.attachShadow({mode: 'closed'});
            const a4 = document.createElement('audio');
            a4.src = '/tone.wav';
            a4.loop = true;
            sr.appendChild(a4);
            await a4.play();

            // 5. Cross-realm same-origin iframe detached audio played via parent HTMLMediaElement.prototype.play.call()
            const ifr = document.createElement('iframe');
            document.body.appendChild(ifr);
            const a5 = ifr.contentDocument.createElement('audio');
            a5.src = location.origin + '/tone.wav';
            a5.loop = true;
            const a5CrossRealm = !(a5 instanceof HTMLMediaElement);
            let a5Err = null;
            try { await HTMLMediaElement.prototype.play.call(a5); } catch (e) { a5Err = String(e); }

            // 6. about:srcdoc iframe playing detached new Audio() inside srcdoc frame
            const fSrcdoc = document.createElement('iframe');
            const srcdocReady = new Promise((resolve) => {
              fSrcdoc.addEventListener('load', resolve, {once: true});
            });
            fSrcdoc.srcdoc = '<!doctype html><script>window.__a6 = new Audio(' + JSON.stringify(location.origin + '/tone.wav') + '); window.__a6.loop = true; window.__a6Play = window.__a6.play();<\\/script>';
            document.body.appendChild(fSrcdoc);
            await srcdocReady;
            await fSrcdoc.contentWindow.__a6Play;
            const a6 = fSrcdoc.contentWindow.__a6;
            const srcdocWs = Boolean(fSrcdoc.contentWindow.autoPauseExtensionInjected);

            // 7. blob: iframe playing detached new Audio() inside blob frame
            const blobUrl = URL.createObjectURL(new Blob([
              '<!doctype html><script>window.__a7 = new Audio(' + JSON.stringify(location.origin + '/tone.wav') + '); window.__a7.loop = true; window.__a7Play = window.__a7.play();<\\/script>'
            ], {type: 'text/html'}));
            const fBlob = document.createElement('iframe');
            const blobReady = new Promise((resolve) => {
              fBlob.addEventListener('load', resolve, {once: true});
            });
            fBlob.src = blobUrl;
            document.body.appendChild(fBlob);
            await blobReady;
            await fBlob.contentWindow.__a7Play;
            const a7 = fBlob.contentWindow.__a7;
            const blobWs = Boolean(fBlob.contentWindow.autoPauseExtensionInjected);

            // 8. sandbox="allow-scripts" (opaque origin) & sandbox="" (no scripts -> must cause 0 errors)
            const sandboxWs = await new Promise((resolve) => {
              const onMsg = (ev) => {
                if (ev.data && ev.data.type === 'sbCheck') {
                  window.removeEventListener('message', onMsg);
                  resolve(Boolean(ev.data.ws));
                }
              };
              window.addEventListener('message', onMsg);
              const fSb = document.createElement('iframe');
              fSb.sandbox = 'allow-scripts';
              fSb.srcdoc = '<!doctype html><script>parent.postMessage({type:"sbCheck", ws: !!window.autoPauseExtensionInjected}, "*");<\\/script>';
              document.body.appendChild(fSb);
            });
            const fSbEmpty = document.createElement('iframe');
            fSbEmpty.sandbox = '';
            fSbEmpty.srcdoc = '<p>sandboxed</p>';
            document.body.appendChild(fSbEmpty);

            // 9. Connected nested closed ShadowRoot audio (isConnected === true, started while Tab 1 is already in state.media!)
            const outerHost = document.createElement('div');
            document.body.appendChild(outerHost);
            const srOuter = outerHost.attachShadow({mode: 'closed'});
            const innerHost = document.createElement('div');
            srOuter.appendChild(innerHost);
            const srInner = innerHost.attachShadow({mode: 'closed'});
            const a8 = document.createElement('audio');
            a8.src = '/tone.wav';
            a8.loop = true;
            srInner.appendChild(a8);
            await a8.play();

            window._matrix = {a1, a2, wrap, a3, frag, a4, host, a5, a5Err, a5CrossRealm, a6, a7, a8};
            return {
              headChildren: document.head.children.length,
              pageSawAutoPauseEvent: window._pageSawAutoPauseEvent,
              a1Detached: !a1.isConnected && a1.parentNode === null,
              a2Intact: !a2.isConnected && a2.parentNode === wrap,
              a3Intact: !a3.isConnected && a3.parentNode === frag,
              a4Detached: !a4.isConnected,
              a5Err,
              srcdocWs,
              blobWs,
              sandboxWs,
              a8Connected: a8.isConnected
            };
          };
          window.getMatrixRates = () => {
            const m = window._matrix;
            return {
              a1: m.a1.playbackRate,
              a2: m.a2.playbackRate,
              a3: m.a3.playbackRate,
              a4: m.a4.playbackRate,
              a5: m.a5.playbackRate,
              a6: m.a6.playbackRate,
              a7: m.a7.playbackRate,
              a8: m.a8.playbackRate,
              headChildren: document.head.children.length,
              pageSawAutoPauseEvent: window._pageSawAutoPauseEvent
            };
          };
          window.replayA1 = async () => {
            const m = window._matrix;
            m.a2.pause(); m.a3.pause(); m.a4.pause(); m.a5.pause(); m.a6.pause(); m.a7.pause(); m.a8.pause();
            m.a1.pause();
            await new Promise((r) => setTimeout(r, 350));
            await m.a1.play();
            return {
              isConnected: m.a1.isConnected,
              parentNode: m.a1.parentNode ? m.a1.parentNode.nodeName : null,
              paused: m.a1.paused,
              playbackRate: m.a1.playbackRate
            };
          };
        </script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/shadow-and-clobber') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(`<!doctype html><html><body>
        <div id="autoPauseContentScript"></div>
        <form id="documentPictureInPicture"><input name="window"></form>
        <img name="pictureInPictureElement">
        <img name="visibilityState">
        <img name="querySelectorAll">
        <img name="nodeType">
        <form id="clobber1">
          <input name="openOrClosedShadowRoot">
          <input name="openOrClosedShadowRoot">
        </form>
        <fieldset name="openOrClosedShadowRoot" form="clobber2">
          <form id="clobber2"></form>
        </fieldset>
        <div id="shadowHost"></div>
        <audio id="spoof" src="/tone.wav" preload="auto"></audio>
        <script>
          const host = document.getElementById('shadowHost');
          const sr = host.attachShadow({mode: 'closed'});
          const audio = document.createElement('audio');
          audio.src = '/tone.wav';
          audio.loop = true;
          sr.appendChild(audio);
          window.playShadow = () => audio.play();
          window.pauseShadow = () => audio.pause();
          window.getShadowState = () => ({
            paused: audio.paused,
            playbackRate: audio.playbackRate,
            volume: audio.volume
          });
          window.spoofEvents = () => {
            const s = document.getElementById('spoof');
            s.dispatchEvent(new Event('play'));
            s.dispatchEvent(new Event('durationchange'));
            window.dispatchEvent(new Event('pagehide'));
            window.dispatchEvent(new Event('visibilitychange'));
            return {duration: s.duration, paused: s.paused};
          };
        </script>
      </body></html>`);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({server, port: server.address().port});
    });
  });
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopause-firefox-'));
  try {
    // =========================================================================
    // PHASE A: Exact unmodified Firefox extension build
    // =========================================================================
    console.log(
      '=== FIREFOX PHASE A: Exact unmodified Firefox extension build ==='
    );
    const extDirA = path.join(tmpRoot, 'ext-a');
    const profDirA = path.join(tmpRoot, 'prof-a');
    buildFirefoxExt(extDirA, null, false);

    const ffA = await launchFirefox(profDirA, await getFreePort());
    try {
      const {bidi} = ffA;
      const errors = [];
      bidi.on('log.entryAdded', (entry) => {
        if (entry.level === 'error') errors.push(entry.text);
      });
      await bidi.send('session.subscribe', {events: ['log.entryAdded']});

      const installed = await bidi.send('webExtension.install', {
        extensionData: {type: 'path', path: extDirA}
      });
      console.log('1. Installed unmodified Firefox extension:', installed);

      await waitFor(async () => {
        const {contexts} = await bidi.send('browsingContext.getTree', {});
        return contexts.some((c) => c.url === 'about:addons');
      }, 8000);
      await sleep(1000);
      console.log('2. onInstalled auto-opened about:addons inline options_ui');
      assert.equal(
        errors.length,
        0,
        `Firefox Phase A errors: ${JSON.stringify(errors)}`
      );
      console.log(
        '3. ZERO console/CSP/JS errors in unmodified Firefox build!\n'
      );
    } finally {
      await ffA.stop();
    }

    // =========================================================================
    // PHASE B: Options page DOM/CSS/CSP + Live Firefox audio, closed Shadow DOM,
    //          DOM Clobbering, Untrusted Events, Detached Audio
    // =========================================================================
    console.log(
      '=== FIREFOX PHASE B: Options UI + Live playback, Shadow DOM, Clobbering, Untrusted Events ==='
    );
    const {server, port: httpPort} = await startTestServer();
    const extDirB = path.join(tmpRoot, 'ext-b');
    const profDirB = path.join(tmpRoot, 'prof-b');
    buildFirefoxExt(
      extDirB,
      ['http://127.0.0.1/*', 'http://localhost/*'],
      true
    );

    const ffB = await launchFirefox(profDirB, await getFreePort());
    try {
      const {bidi} = ffB;
      const errors = [];
      bidi.on('log.entryAdded', (entry) => {
        if (entry.level === 'error') errors.push(entry.text);
      });
      await bidi.send('session.subscribe', {events: ['log.entryAdded']});

      await bidi.send('webExtension.install', {
        extensionData: {type: 'path', path: extDirB}
      });

      // onInstalled opens options.html in a tab when open_in_tab: true!
      const optCtx = await waitFor(async () => {
        const {contexts} = await bidi.send('browsingContext.getTree', {});
        return contexts.find((c) => c.url && c.url.endsWith('/options.html'));
      }, 10000);
      await sleep(500);
      console.log('1. Options page opened:', optCtx.url);

      const optState = await evalBiDi(
        bidi,
        optCtx.context,
        `(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        color: getComputedStyle(document.body).color,
        chromeOnlyHidden: document.getElementById('chromeonly').hidden,
        shortcutInputs: document.querySelectorAll('#shortcuts input').length
      }))()`
      );
      console.log('2. Firefox options.html state:', optState);
      assert.equal(
        optState.bg,
        'rgb(27, 38, 44)',
        'options.css background must apply under Firefox CSP'
      );
      assert.equal(
        optState.color,
        'rgb(255, 255, 255)',
        'options.css color must apply under Firefox CSP'
      );
      assert.equal(
        optState.chromeOnlyHidden,
        true,
        '#chromeonly must stay hidden on Firefox'
      );
      assert.equal(
        optState.shortcutInputs,
        12,
        'options-firefox.js must render all 12 shortcut inputs'
      );

      // Toggle checkbox and verify sync storage write (note: keep muteonpause off for audio playback test below)
      await evalBiDi(
        bidi,
        optCtx.context,
        `document.getElementById('ignoreshort').click()`
      );
      await sleep(300);
      const stored = await evalBiDi(
        bidi,
        optCtx.context,
        `browser.storage.sync.get('options').then(r => Boolean(r.options && r.options.ignoreshort))`
      );
      assert.equal(
        stored,
        true,
        'Firefox options checkbox must persist to storage.sync'
      );
      await evalBiDi(
        bidi,
        optCtx.context,
        `document.getElementById('ignoreshort').click()`
      );
      await sleep(200);
      console.log(
        '3. Firefox options checkbox -> browser.storage.sync verified!'
      );

      // Open Tab 1 (/normal) and Tab 2 (/shadow-and-clobber)
      const {context: tab1} = await bidi.send('browsingContext.create', {
        type: 'tab'
      });
      await bidi.send('browsingContext.navigate', {
        context: tab1,
        url: `http://127.0.0.1:${httpPort}/normal`,
        wait: 'complete'
      });
      const {context: tab2} = await bidi.send('browsingContext.create', {
        type: 'tab'
      });
      await bidi.send('browsingContext.navigate', {
        context: tab2,
        url: `http://127.0.0.1:${httpPort}/shadow-and-clobber`,
        wait: 'complete'
      });
      await sleep(500);

      // Verify WindowScript injected in MAIN world
      const wsFlag = await evalBiDi(
        bidi,
        tab1,
        `window.autoPauseExtensionInjected`
      );
      assert.equal(
        wsFlag,
        true,
        'WindowScript must inject in Firefox MAIN world'
      );
      console.log('4. WindowScript.js injected cleanly in Firefox MAIN world');

      // Activate Tab 1 and play audio
      await bidi.send('browsingContext.activate', {context: tab1});
      await sleep(250);
      await evalBiDi(bidi, tab1, `window.playAudio()`);
      await sleep(600);
      const t1Playing = await evalBiDi(bidi, tab1, `window.getAudioState()`);
      assert.equal(t1Playing.paused, false);
      assert.equal(t1Playing.playbackRate, 1);
      console.log('5. Tab 1 playing in Firefox:', t1Playing);

      // Fire untrusted synthetic events on background Tab 2 -> Tab 1 & session state must stay unaffected
      const spoofRes = await evalBiDi(bidi, tab2, `window.spoofEvents()`);
      await sleep(500);
      const t1AfterSpoof = await evalBiDi(bidi, tab1, `window.getAudioState()`);
      const sessAfterSpoof = await evalBiDi(
        bidi,
        optCtx.context,
        `browser.storage.session.get('state').then(s => JSON.stringify(s.state))`
      );
      const parsedSess = JSON.parse(sessAfterSpoof);
      assert.equal(
        t1AfterSpoof.playbackRate,
        1,
        'Untrusted events on Tab 2 must not pause Tab 1'
      );
      assert.equal(
        parsedSess.media.length,
        1,
        `Untrusted play must not add Tab 2 to state.media: ${sessAfterSpoof}`
      );
      console.log(
        '6. Untrusted synthetic events on Tab 2 ignored (spoof duration =',
        spoofRes.duration,
        ', state.media =',
        parsedSess.media,
        ')'
      );

      // Activate Tab 2 (all 3 DOM clobbering payloads + closed ShadowRoot player!) and play
      await bidi.send('browsingContext.activate', {context: tab2});
      await sleep(250);
      await evalBiDi(bidi, tab2, `window.playShadow()`);

      // Tab 1 must get auto-paused (playbackRate === 0, volume === 0) without exposing volumechange/ratechange
      const t1Paused = await waitFor(async () => {
        const s = await evalBiDi(bidi, tab1, `window.getAudioState()`);
        return s.playbackRate === 0 && s.volume === 0 ? s : null;
      }, 10000);
      await sleep(150);
      const t1AfterPause = await evalBiDi(bidi, tab1, `window.getAudioState()`);
      assert.equal(
        t1AfterPause.pageSawZeroVolume,
        0,
        'Firefox page must NOT see temporary volume=0'
      );
      assert.equal(
        t1AfterPause.pageSawZeroRate,
        0,
        'Firefox page must NOT see temporary playbackRate=0'
      );
      assert.equal(
        t1AfterPause.captureLeakCount,
        0,
        'Firefox window/document/body/target capture listeners must NOT see temporary volume=0 or playbackRate=0'
      );
      const muteFlips = await evalBiDi(
        bidi,
        tab1,
        `window.testMuteUnmuteWhilePaused()`
      );
      assert.equal(
        muteFlips.length,
        2,
        `Firefox Mute->Unmute while paused must both reach page: ${JSON.stringify(muteFlips)}`
      );
      assert.equal(muteFlips[0].muted, true);
      assert.equal(muteFlips[1].muted, false);

      // Denied background watchdog rate-reset in Firefox: volume must NEVER leave 0 and rate must snap back to 0!
      await evalBiDi(
        bidi,
        tab1,
        `(() => {
      const a = document.getElementById('a');
      window._maxVolDuringDeniedReset = 0;
      const onVol = () => { if (a.volume > window._maxVolDuringDeniedReset) window._maxVolDuringDeniedReset = a.volume; };
      a.addEventListener('volumechange', onVol);
      window._cleanupDeniedReset = () => a.removeEventListener('volumechange', onVol);
      a.playbackRate = 1.5;
    })()`
      );
      await waitFor(async () => {
        const s = await evalBiDi(bidi, tab1, `window.getAudioState()`);
        return s.playbackRate === 0 && s.volume === 0 ? s : null;
      }, 5000);
      await sleep(150);
      const ffMaxVolDenied = await evalBiDi(
        bidi,
        tab1,
        `(() => { window._cleanupDeniedReset(); return window._maxVolDuringDeniedReset; })()`
      );
      assert.equal(
        ffMaxVolDenied,
        0,
        'Firefox denied background playbackRate reset must NEVER restore volume > 0'
      );

      // Allowed userActivation rate-reset (1.5x) while auto-paused -> background sends normalPlayback, restoring volume=1 & keeping 1.5x!
      await bidi.send('script.evaluate', {
        expression: `document.getElementById('a').playbackRate = 1.5`,
        target: {context: tab1},
        awaitPromise: false,
        userActivation: true
      });
      const ffRateRestored = await waitFor(async () => {
        const s = await evalBiDi(bidi, tab1, `window.getAudioState()`);
        return s.volume === 1 ? s : null;
      }, 5000);
      assert.equal(
        ffRateRestored.playbackRate,
        1.5,
        'Firefox normalPlayback must preserve playbackRate=1.5'
      );
      await evalBiDi(
        bidi,
        tab1,
        `document.getElementById('a').playbackRate = 1`
      );
      // Re-play Tab 2 shadow audio so step 8 pauseShadow -> Tab 1 auto-resume still tests cleanly
      await evalBiDi(bidi, tab2, `window.pauseShadow()`);
      await sleep(300);
      await evalBiDi(bidi, tab2, `window.playShadow()`);
      await waitFor(async () => {
        const s = await evalBiDi(bidi, tab1, `window.getAudioState()`);
        return s.playbackRate === 0 && s.volume === 0 ? s : null;
      }, 10000);
      console.log(
        '7. Closed Shadow DOM audio on clobbered page auto-paused Tab 1 in Firefox (capture/bubble hidden, Mute->Unmute passed through, denied & allowed rate-reset verified):',
        t1AfterPause,
        muteFlips
      );

      // Pause Tab 2 Shadow DOM audio -> Tab 1 must auto-resume!
      await evalBiDi(bidi, tab2, `window.pauseShadow()`);
      const t1Resumed = await waitFor(async () => {
        const s = await evalBiDi(bidi, tab1, `window.getAudioState()`);
        return s.playbackRate === 1 && s.volume === 1 ? s : null;
      }, 10000);
      console.log(
        '8. Pausing Shadow DOM audio auto-resumed Tab 1 in Firefox:',
        t1Resumed
      );

      // Test overlapping pause->play->pause->play debounce race: Tab 1 must stay tracked & auto-pause when Tab 2 plays!
      await bidi.send('browsingContext.activate', {context: tab1});
      const ffDebounce = await evalBiDi(
        bidi,
        tab1,
        `window.testOverlappingPauseDebounce()`
      );
      assert.equal(ffDebounce.paused, false);
      assert.equal(ffDebounce.playbackRate, 1);
      await bidi.send('browsingContext.activate', {context: tab2});
      await sleep(150);
      await evalBiDi(bidi, tab2, `window.playShadow()`);
      await waitFor(async () => {
        const s = await evalBiDi(bidi, tab1, `window.getAudioState()`);
        return s.playbackRate === 0 && s.volume === 0 ? s : null;
      }, 10000);
      const ffAfterDebouncePause = await evalBiDi(
        bidi,
        tab1,
        `window.getAudioState()`
      );
      assert.equal(
        ffAfterDebouncePause.captureLeakCount,
        0,
        'Capture leak count must stay 0 after debounce re-pause'
      );
      await evalBiDi(bidi, tab2, `window.pauseShadow()`);
      await waitFor(async () => {
        const s = await evalBiDi(bidi, tab1, `window.getAudioState()`);
        return s.playbackRate === 1 && s.volume === 1 ? s : null;
      }, 10000);
      console.log(
        '8a. Firefox overlapping pause->play->pause debounce preserved tracking & zero capture leaks!'
      );

      // Test muted media paused on tab hide & resumed on tab show in Firefox
      await bidi.send('browsingContext.activate', {context: tab1});
      await evalBiDi(bidi, tab1, `window.pauseAudio()`);
      await sleep(350);
      await evalBiDi(bidi, tab1, `window.startMutedMedia()`);
      await sleep(250);
      // Unmounting an empty ad/widget iframe fires pagehide in the subframe; must NOT wipe state.mutedTabs!
      await evalBiDi(
        bidi,
        tab1,
        `(async () => {
      const ad = document.createElement('iframe');
      const loaded = new Promise((r) => ad.addEventListener('load', r, {once: true}));
      ad.srcdoc = '<p>ad</p>';
      document.body.appendChild(ad);
      await loaded;
      await new Promise((r) => setTimeout(r, 80));
      ad.remove();
      await new Promise((r) => setTimeout(r, 150));
    })()`
      );
      await bidi.send('browsingContext.activate', {context: tab2});
      await waitFor(async () => {
        const s = await evalBiDi(bidi, tab1, `window.getMutedMediaState()`);
        return s.playbackRate === 0 ? s : null;
      }, 10000);
      await sleep(100);
      const ffMutedPaused = await evalBiDi(
        bidi,
        tab1,
        `window.getMutedMediaState()`
      );
      assert.equal(
        ffMutedPaused.volume,
        0.8,
        'Firefox muted media volume must stay 0.8 when paused'
      );
      assert.equal(
        ffMutedPaused.volChanges,
        0,
        'Firefox muted media must fire 0 volumechange events when paused'
      );
      await bidi.send('browsingContext.activate', {context: tab1});
      await waitFor(async () => {
        const s = await evalBiDi(bidi, tab1, `window.getMutedMediaState()`);
        return s.playbackRate === 1 ? s : null;
      }, 10000);
      await sleep(100);
      const ffMutedResumed = await evalBiDi(
        bidi,
        tab1,
        `window.getMutedMediaState()`
      );
      assert.equal(
        ffMutedResumed.volume,
        0.8,
        'Firefox muted media volume must stay 0.8 when resumed'
      );
      assert.equal(
        ffMutedResumed.volChanges,
        0,
        'Firefox muted media must fire 0 volumechange events across pause+resume'
      );
      await evalBiDi(bidi, tab1, `window.stopMutedMedia()`);
      await sleep(350);
      console.log(
        '8b. Firefox muted media survived empty iframe pagehide, paused on hide & resumed on show with volume=0.8 and 0 volumechange events:',
        ffMutedPaused,
        '->',
        ffMutedResumed
      );

      // Test full detached-media matrix via FocusEvent.relatedTarget (ZERO DOM mutations!)
      const matrixInit = await evalBiDi(
        bidi,
        tab1,
        `window.startDetachedMatrix()`
      );
      console.log(
        '9a. Firefox detached + connected nested ShadowRoot matrix started:',
        matrixInit
      );
      assert.equal(
        matrixInit.headChildren,
        0,
        'WindowScript must NOT mutate document.head in Firefox'
      );
      assert.equal(
        matrixInit.pageSawAutoPauseEvent,
        0,
        'Firefox page listeners must NOT see autoPauseMedia'
      );
      assert.equal(matrixInit.a1Detached, true);
      assert.equal(matrixInit.a2Intact, true);
      assert.equal(matrixInit.a3Intact, true);
      assert.equal(matrixInit.a4Detached, true);
      assert.equal(
        matrixInit.srcdocWs,
        true,
        'WindowScript must inject into about:srcdoc iframe in Firefox'
      );
      assert.equal(
        matrixInit.blobWs,
        true,
        'WindowScript must inject into blob: iframe in Firefox'
      );
      assert.equal(
        matrixInit.sandboxWs,
        true,
        'WindowScript must inject into sandbox="allow-scripts" iframe in Firefox'
      );
      assert.equal(
        matrixInit.a8Connected,
        true,
        'a8 must be a connected nested closed ShadowRoot audio'
      );

      // Play Tab 2 -> ALL elements (a1..a8 including srcdoc, blob, & connected nested closed ShadowRoot) on Tab 1 must be auto-paused!
      await bidi.send('browsingContext.activate', {context: tab2});
      await sleep(250);
      await evalBiDi(bidi, tab2, `window.playShadow()`);
      const matrixPaused = await waitFor(async () => {
        const r = await evalBiDi(bidi, tab1, `window.getMatrixRates()`);
        return r.a1 === 0 &&
          r.a2 === 0 &&
          r.a3 === 0 &&
          r.a4 === 0 &&
          r.a5 === 0 &&
          r.a6 === 0 &&
          r.a7 === 0 &&
          r.a8 === 0
          ? r
          : null;
      }, 10000);
      console.log(
        '9b. Firefox detached + connected nested ShadowRoot matrix auto-paused by Tab 2:',
        matrixPaused
      );

      // Pause Tab 2 -> ALL elements must auto-resume!
      await evalBiDi(bidi, tab2, `window.pauseShadow()`);
      const matrixResumed = await waitFor(async () => {
        const r = await evalBiDi(bidi, tab1, `window.getMatrixRates()`);
        return r.a1 === 1 &&
          r.a2 === 1 &&
          r.a3 === 1 &&
          r.a4 === 1 &&
          r.a5 === 1 &&
          r.a6 === 1 &&
          r.a7 === 1 &&
          r.a8 === 1
          ? r
          : null;
      }, 10000);
      assert.equal(matrixResumed.headChildren, 0);
      assert.equal(matrixResumed.pageSawAutoPauseEvent, 0);

      // Replay a1 after pause and verify Tab 2 can auto-pause it again!
      await bidi.send('browsingContext.activate', {context: tab1});
      const replayState = await evalBiDi(bidi, tab1, `window.replayA1()`);
      assert.equal(replayState.isConnected, false);
      assert.equal(replayState.parentNode, null);
      await bidi.send('browsingContext.activate', {context: tab2});
      await sleep(250);
      await evalBiDi(bidi, tab2, `window.playShadow()`);
      const replayedPaused = await waitFor(async () => {
        const r = await evalBiDi(bidi, tab1, `window.getMatrixRates()`);
        return r.a1 === 0 ? r : null;
      }, 10000);
      await evalBiDi(bidi, tab2, `window.pauseShadow()`);
      console.log(
        '9c. Firefox detached a1 replayed & auto-paused again cleanly:',
        replayedPaused
      );

      // Verify programmatic re-injection of ContentScript.js works cleanly in Firefox (IIFE guard)
      const reinj = await evalBiDi(
        bidi,
        optCtx.context,
        `browser.tabs.query({url: 'http://127.0.0.1/*'}).then(async (ts) => {
        await browser.scripting.executeScript({target: {tabId: ts[0].id, allFrames: true}, files: ['ContentScript.js']});
        return 'OK';
      })`
      );
      assert.equal(reinj, 'OK');
      console.log(
        '10. Programmatic re-injection of ContentScript.js succeeded cleanly in Firefox!'
      );

      // Verify src = '' + load() teardown (emptied event) cleans up Elements & state.media in Firefox!
      await sleep(300);
      const tab2Id = await evalBiDi(
        bidi,
        optCtx.context,
        `browser.tabs.query({url: 'http://127.0.0.1/shadow-and-clobber'}).then((ts) => ts[0]?.id)`
      );
      assert.ok(tab2Id, 'Expected tab2Id for /shadow-and-clobber');
      await evalBiDi(
        bidi,
        tab2,
        `(async () => {
        const a = document.createElement('audio');
        a.src = '/tone.wav?emptied';
        document.body.appendChild(a);
        await a.play();
        await new Promise((r) => setTimeout(r, 350));
        window._emptiedAudio = a;
      })()`
      );
      await waitFor(
        () =>
          evalBiDi(
            bidi,
            optCtx.context,
            `browser.storage.session.get('state').then((r) => r.state?.media?.includes(${tab2Id}))`
          ),
        5000
      );
      await evalBiDi(
        bidi,
        tab2,
        `(() => { window._emptiedAudio.src = ''; window._emptiedAudio.load(); })()`
      );
      const ffEmptiedCleaned = await waitFor(async () => {
        const inMedia = await evalBiDi(
          bidi,
          optCtx.context,
          `browser.storage.session.get('state').then((r) => r.state?.media?.includes(${tab2Id}))`
        );
        return !inMedia ? {inMedia} : null;
      }, 5000);
      console.log(
        '10b. Firefox src=\"\" + load() teardown cleaned up Elements & state.media via emptied:',
        ffEmptiedCleaned
      );

      // 10c. Firefox rapid <200ms pause()->play() while auto-paused (denied background + allowed userActivation + sibling isolation)
      await bidi.send('browsingContext.activate', {context: tab1});
      await sleep(200);
      await evalBiDi(
        bidi,
        tab1,
        `(async () => {
        const a = document.createElement('audio');
        a.src = '/tone.wav?ffRapidA';
        a.loop = true;
        const b = document.createElement('audio');
        b.src = '/tone.wav?ffRapidB';
        b.loop = true;
        document.body.append(a, b);
        window._ffRapidA = a;
        window._ffRapidB = b;
        await a.play();
        await b.play();
      })()`,
        true,
        true
      );
      await sleep(400);
      // Activate Tab 2 and play shadow audio -> auto-pauses BOTH _ffRapidA and _ffRapidB on Tab 1
      await bidi.send('browsingContext.activate', {context: tab2});
      await sleep(200);
      await evalBiDi(bidi, tab2, `window.playShadow()`, true, true);
      await waitFor(
        () =>
          evalBiDi(
            bidi,
            tab1,
            `_ffRapidA.playbackRate === 0 && _ffRapidB.playbackRate === 0`
          ),
        5000
      );
      // Denied background rapid pause->play (no user activation) must STAY at 0
      await evalBiDi(
        bidi,
        tab1,
        `(async () => { _ffRapidA.pause(); await _ffRapidA.play(); })()`
      );
      await sleep(400);
      const ffRapidDenied = await evalBiDi(
        bidi,
        tab1,
        `({aRate: _ffRapidA.playbackRate, aVol: _ffRapidA.volume})`
      );
      assert.equal(
        ffRapidDenied.aRate,
        0,
        `Firefox denied rapid pause->play bypassed AutoPause! ${JSON.stringify(ffRapidDenied)}`
      );
      assert.equal(
        ffRapidDenied.aVol,
        0,
        `Firefox denied rapid pause->play restored volume! ${JSON.stringify(ffRapidDenied)}`
      );

      // Allowed rapid pause->play WITH userActivation on _ffRapidB must restore ONLY _ffRapidB (not _ffRapidA)
      await evalBiDi(
        bidi,
        tab1,
        `(async () => { _ffRapidB.pause(); await _ffRapidB.play(); })()`,
        true,
        true
      );
      const ffRapidAllowed = await waitFor(async () => {
        const s = await evalBiDi(
          bidi,
          tab1,
          `({aRate: _ffRapidA.playbackRate, aVol: _ffRapidA.volume, bRate: _ffRapidB.playbackRate, bVol: _ffRapidB.volume})`
        );
        return s.bRate === 1 && s.bVol === 1 ? s : null;
      }, 5000);
      assert.equal(
        ffRapidAllowed.aRate,
        0,
        `Firefox sibling _ffRapidA wrongly woken! ${JSON.stringify(ffRapidAllowed)}`
      );
      assert.equal(
        ffRapidAllowed.aVol,
        0,
        `Firefox sibling _ffRapidA volume wrongly restored! ${JSON.stringify(ffRapidAllowed)}`
      );
      await evalBiDi(bidi, tab1, `_ffRapidA.pause(); _ffRapidB.pause(); true`);
      await evalBiDi(bidi, tab2, `window.pauseShadow()`);
      console.log(
        '10c. Firefox rapid <200ms pause->play (denied, allowed + sibling isolation) verified:',
        {ffRapidDenied, ffRapidAllowed}
      );

      // 10d. Firefox muteonpause (extensionId === runtime.id, keeps state.media, respects disableresume),
      //      audible pause with muted media remaining, and declarative closed-shadow autoplay pause!
      await sleep(350);
      const tab1Id = await evalBiDi(
        bidi,
        optCtx.context,
        `browser.tabs.query({url: 'http://127.0.0.1/normal'}).then((ts) => ts[0]?.id)`
      );
      assert.ok(tab1Id, 'Expected tab1Id for /normal');
      await evalBiDi(
        bidi,
        optCtx.context,
        `browser.storage.sync.set({options: {muteonpause: true, disableresume: true}})`
      );
      await sleep(200);
      await bidi.send('browsingContext.activate', {context: tab1});
      await sleep(200);
      await evalBiDi(
        bidi,
        tab1,
        `(async () => {
          const a = document.createElement('audio');
          a.src = '/tone.wav?ffMop';
          a.loop = true;
          document.body.appendChild(a);
          window._ffMop = a;
          await a.play();
        })()`,
        true,
        true
      );
      await waitFor(
        () =>
          evalBiDi(
            bidi,
            optCtx.context,
            `browser.storage.session.get('state').then((r) => r.state?.media?.includes(${tab1Id}))`
          ),
        5000
      );
      await bidi.send('browsingContext.activate', {context: tab2});
      await sleep(200);
      await evalBiDi(bidi, tab2, `window.playShadow()`, true, true);
      const ffMopPaused = await waitFor(async () => {
        const s = await evalBiDi(
          bidi,
          optCtx.context,
          `(async () => {
            const t = await browser.tabs.get(${tab1Id});
            const {state} = await browser.storage.session.get('state');
            return {
              muted: t.mutedInfo?.muted,
              extIdMatch: t.mutedInfo?.extensionId === browser.runtime.id,
              inMedia: Boolean(state?.media?.includes(${tab1Id})),
              inMutedMedia: Boolean(state?.mutedMedia?.includes(${tab1Id}))
            };
          })()`
        );
        return s.muted === true ? s : null;
      }, 5000);
      await sleep(250);
      const ffMopState = await evalBiDi(
        bidi,
        optCtx.context,
        `browser.storage.session.get('state').then(({state}) => ({
          inMedia: Boolean(state?.media?.includes(${tab1Id})),
          inMutedMedia: Boolean(state?.mutedMedia?.includes(${tab1Id}))
        }))`
      );
      assert.equal(
        ffMopPaused.extIdMatch,
        true,
        `Firefox mutedInfo.extensionId did not match browser.runtime.id: ${JSON.stringify(ffMopPaused)}`
      );
      assert.equal(ffMopState.inMedia, true);
      assert.equal(ffMopState.inMutedMedia, false);
      // Activate Tab 1 -> muteonpause + disableresume must unmute and pause cleanly (NOT force-resume!)
      await bidi.send('browsingContext.activate', {context: tab1});
      await sleep(400);
      const ffMopDisableResume = await evalBiDi(
        bidi,
        tab1,
        `({paused: _ffMop.paused, rate: _ffMop.playbackRate})`
      );
      assert.equal(
        ffMopDisableResume.paused,
        true,
        `Firefox muteonpause bypassed disableresume! ${JSON.stringify(ffMopDisableResume)}`
      );
      await evalBiDi(
        bidi,
        optCtx.context,
        `browser.storage.sync.set({options: {}})`
      );
      await evalBiDi(
        bidi,
        optCtx.context,
        `browser.tabs.update(${tab1Id}, {muted: false})`
      );
      await evalBiDi(bidi, tab2, `window.pauseShadow()`);
      await sleep(350);

      // Audible pauses while muted audio remains -> must stay in state.mutedTabs and pause on hide!
      await evalBiDi(
        bidi,
        tab1,
        `(async () => {
          const m = document.createElement('audio');
          m.src = '/tone.wav?ffStayMuted';
          m.loop = true;
          m.muted = true;
          document.body.appendChild(m);
          window._ffStayMuted = m;
          await m.play();
          await _ffMop.play();
        })()`,
        true,
        true
      );
      await waitFor(
        () =>
          evalBiDi(
            bidi,
            optCtx.context,
            `browser.storage.session.get('state').then((r) => r.state?.media?.includes(${tab1Id}))`
          ),
        5000
      );
      await evalBiDi(bidi, tab1, `_ffMop.pause(); true`);
      await waitFor(
        () =>
          evalBiDi(
            bidi,
            optCtx.context,
            `browser.storage.session.get('state').then((r) => !r.state?.media?.includes(${tab1Id}) && r.state?.mutedTabs?.includes(${tab1Id}))`
          ),
        5000
      );
      await bidi.send('browsingContext.activate', {context: tab2});
      const ffStayMutedPaused = await waitFor(async () => {
        const r = await evalBiDi(bidi, tab1, `_ffStayMuted.playbackRate`);
        return r === 0 ? {rate: r} : null;
      }, 5000);
      await evalBiDi(bidi, tab1, `_ffStayMuted.pause(); true`);
      await sleep(300);

      // Declarative closed ShadowRoot <audio autoplay> caught by pause() while tab already in state.media!
      await bidi.send('browsingContext.activate', {context: tab1});
      await sleep(200);
      await evalBiDi(
        bidi,
        tab1,
        `(async () => {
          await _ffMop.play();
          const h = document.createElement('div');
          document.body.appendChild(h);
          const sr = h.attachShadow({mode: 'closed'});
          const a = document.createElement('audio');
          a.autoplay = true;
          a.loop = true;
          a.src = '/tone.wav?ffDeclShadow';
          sr.appendChild(a);
          window._ffDeclShadow = a;
          await new Promise((resolve) => {
            if (!a.paused) return resolve();
            a.addEventListener('play', resolve, {once: true});
          });
        })()`,
        true,
        true
      );
      await bidi.send('browsingContext.activate', {context: tab2});
      await sleep(200);
      await evalBiDi(bidi, tab2, `window.playShadow()`, true, true);
      const ffDeclShadowPaused = await waitFor(async () => {
        const s = await evalBiDi(
          bidi,
          tab1,
          `({paused: _ffDeclShadow.paused, rate: _ffDeclShadow.playbackRate, vol: _ffDeclShadow.volume})`
        );
        return !s.paused && s.rate === 0 && s.vol === 0 ? s : null;
      }, 5000);
      await evalBiDi(
        bidi,
        tab1,
        `_ffMop.pause(); _ffDeclShadow.pause(); true`
      );
      await evalBiDi(bidi, tab2, `window.pauseShadow()`);
      console.log(
        '10d. Firefox muteonpause (extensionId + disableresume), audible->playMuted, and declarative shadow autoplay verified:',
        {ffMopPaused, ffMopDisableResume, ffStayMutedPaused, ffDeclShadowPaused}
      );

      assert.equal(
        errors.length,
        0,
        `Firefox Phase B errors: ${JSON.stringify(errors)}`
      );
      console.log('11. ZERO console/JS/CSP errors in Firefox Phase B!');
      console.log('\nALL LIVE FIREFOX E2E SMOKE TESTS PASSED!');
    } finally {
      await ffB.stop();
      server.closeAllConnections?.();
      server.close();
    }
  } finally {
    fs.rmSync(tmpRoot, {recursive: true, force: true});
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FIREFOX SMOKE TEST FAILED:', err);
    process.exit(1);
  });
