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
const CHROME = process.env.CHROME_BIN || 'chromium';

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

// Generate a real 5-second 440Hz PCM WAV so Chromium plays genuine audible audio
function makeWav(seconds = 5, sampleRate = 8000, freq = 440) {
  const numSamples = seconds * sampleRate;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * freq * i) / sampleRate) * 16000
    );
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

const WAV_BUF = makeWav(10);

class CDPClient {
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
        if (msg.error)
          reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        const key = `${msg.sessionId || ''}:${msg.method}`;
        for (const fn of this.listeners.get(key) || []) fn(msg.params);
        for (const fn of this.listeners.get(`*:${msg.method}`) || [])
          fn(msg.params, msg.sessionId);
      }
    });
  }
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    const payload = sessionId
      ? {id, method, params, sessionId}
      : {id, method, params};
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(method, fn, sessionId = '*') {
    const key = `${sessionId}:${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(fn);
  }
  close() {
    this.ws?.close();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 10000, intervalMs = 150) {
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

function buildChromeExt(destDir, extraHostPermissions = null) {
  fs.rmSync(destDir, {recursive: true, force: true});
  fs.mkdirSync(destDir, {recursive: true});
  for (const name of fs.readdirSync(REPO)) {
    if (/\.(js|css|html|json|png)$/.test(name) || name === 'LICENSE') {
      if (name.includes('-firefox.') || name === 'icon.png') continue;
      let target = name;
      if (name === 'manifest-chrome.json') target = 'manifest.json';
      if (name === 'options-chrome.js') target = 'options-browser.js';
      fs.copyFileSync(path.join(REPO, name), path.join(destDir, target));
    }
  }
  if (extraHostPermissions) {
    const mPath = path.join(destDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    manifest.host_permissions = extraHostPermissions;
    fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2));
  }
}

async function launchChromium(extDir, profileDir, port) {
  fs.rmSync(profileDir, {recursive: true, force: true});
  fs.mkdirSync(profileDir, {recursive: true});
  const chromeArgs = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extDir}`,
    `--disable-extensions-except=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-features=DocumentPictureInPictureAPI',
    'about:blank'
  ];
  const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
  const proc = spawn(
    useXvfb ? 'xvfb-run' : CHROME,
    useXvfb ? ['-a', CHROME, ...chromeArgs] : chromeArgs,
    {stdio: ['ignore', 'pipe', 'pipe'], detached: true}
  );
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d.toString()));
  proc.stderr.on('data', (d) => (logs += d.toString()));

  const version = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!r.ok) return null;
    return r.json();
  }, 15000);

  const cdp = new CDPClient(version.webSocketDebuggerUrl);
  await cdp.connect();
  return {
    proc,
    cdp,
    getLogs: () => logs,
    async stop() {
      cdp.close();
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {}
      await sleep(200);
    }
  };
}

async function evalInSession(cdp, sessionId, expression, awaitPromise = true) {
  const res = await cdp.send(
    'Runtime.evaluate',
    {expression, awaitPromise, returnByValue: true},
    sessionId
  );
  if (res.exceptionDetails) {
    throw new Error(
      `Runtime exception: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`
    );
  }
  return res.result?.value;
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
        <button id="detached">Play detached</button>
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

            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const dest = ctx.createMediaStreamDestination();
            osc.connect(dest);
            osc.start();
            const ms = document.createElement('audio');
            ms.srcObject = dest.stream;
            ms.muted = true;
            ms.volume = 0.7;
            document.body.appendChild(ms);
            await ms.play();
            await new Promise((r) => setTimeout(r, 80));
            window._msVolEvents = [];
            ms.addEventListener('volumechange', () => {
              window._msVolEvents.push({muted: ms.muted, volume: ms.volume});
            });
            window._msCtx = ctx;
            window._msAudio = ms;
          };
          window.getMutedMediaState = () => ({
            paused: window._mutedMedia.paused,
            playbackRate: window._mutedMedia.playbackRate,
            volume: window._mutedMedia.volume,
            muted: window._mutedMedia.muted,
            volChanges: window._mutedVolChanges,
            msRate: window._msAudio.playbackRate,
            msVol: window._msAudio.volume,
            msMuted: window._msAudio.muted,
            msEvents: window._msVolEvents.slice()
          });
          window.unmuteStreamWhilePaused = async () => {
            window._msAudio.muted = false;
            await new Promise((r) => setTimeout(r, 100));
            return window.getMutedMediaState();
          };
          window.dragVolumeToZeroWhilePaused = async () => {
            window._muteEvents = [];
            window._allowZeroVolCapture = true;
            mainAudio.volume = 0.4;
            await new Promise((r) => setTimeout(r, 80));
            mainAudio.volume = 0;
            await new Promise((r) => setTimeout(r, 80));
            window._allowZeroVolCapture = false;
            return window._muteEvents.slice();
          };
          window.stopMutedMedia = () => {
            window._mutedMedia.pause();
            window._mutedMedia.remove();
            window._msAudio.pause();
            window._msAudio.srcObject = null;
            window._msAudio.remove();
            window._msCtx.close();
          };
          window.getAudioState = () => ({
            paused: mainAudio.paused,
            playbackRate: mainAudio.playbackRate,
            volume: mainAudio.volume,
            muted: mainAudio.muted,
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
            window._detachedAudio = a1;
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
          window.pauseMatrixExceptA1 = () => {
            const m = window._matrix;
            m.a2.pause(); m.a3.pause(); m.a4.pause(); m.a5.pause(); m.a6.pause(); m.a7.pause(); m.a8.pause();
          };
          window.replayA1 = async () => {
            window._matrix.a1.pause();
            await new Promise((r) => setTimeout(r, 350));
            await window._matrix.a1.play();
          };
          window.getDetachedState = () => {
            const a = window._detachedAudio;
            return {
              isConnected: a.isConnected,
              parentNode: a.parentNode ? a.parentNode.nodeName : null,
              paused: a.paused,
              playbackRate: a.playbackRate,
              volume: a.volume
            };
          };
        </script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/shadow-and-clobber') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(`<!doctype html><html><body>
        <!-- DOM clobbering attacks against ContentScript.js -->
        <div id="autoPauseContentScript"></div>
        <form id="documentPictureInPicture"><input name="window"></form>
        <img name="pictureInPictureElement">
        <form id="clobber1">
          <input name="openOrClosedShadowRoot">
          <input name="openOrClosedShadowRoot">
        </form>
        <fieldset name="openOrClosedShadowRoot" form="clobber2">
          <form id="clobber2"></form>
        </fieldset>
        <!-- Closed shadow DOM audio player -->
        <div id="shadowHost"></div>
        <!-- Paused audio for synthetic event spoofing test -->
        <audio id="spoof" src="/tone.wav" preload="auto"></audio>
        <script>
          const host = document.getElementById('shadowHost');
          const sr = host.attachShadow({mode: 'closed'});
          const audio = document.createElement('audio');
          audio.src = '/tone.wav';
          audio.loop = true;
          sr.appendChild(audio);
          window._shadowAudio = audio;
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
    if (url.pathname === '/docpip') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(`<!doctype html><html><body>
        <button id="openPip" style="width:200px;height:100px;">Open PiP</button>
        <script>
          document.getElementById('openPip').addEventListener('click', async () => {
            try {
              const pipWin = await documentPictureInPicture.requestWindow({width: 300, height: 200});
              window._pipCaptureLeaks = 0;
              window._pipAutoPauseLeaks = 0;
              pipWin.document.addEventListener('autoPauseMedia', () => { window._pipAutoPauseLeaks++; }, true);
              const host = pipWin.document.createElement('div');
              const sr = host.attachShadow({mode: 'closed'});
              const a = pipWin.document.createElement('audio');
              a.src = '/tone.wav';
              a.loop = true;
              sr.appendChild(a);
              pipWin.document.body.appendChild(host);
              const light = pipWin.document.createElement('audio');
              light.src = '/tone.wav';
              light.loop = true;
              pipWin.document.body.appendChild(light);
              for (const tgt of [pipWin.document, light]) {
                tgt.addEventListener('volumechange', (e) => {
                  if (e.target === light && light.volume === 0) window._pipCaptureLeaks++;
                }, true);
                tgt.addEventListener('ratechange', (e) => {
                  if (e.target === light && light.playbackRate === 0) window._pipCaptureLeaks++;
                }, true);
              }
              window._pipWin = pipWin;
              window._pipAudio = a;
              window._pipLightAudio = light;
              await a.play();
              await light.play();
              window._pipOpened = true;
            } catch (e) {
              window._pipError = String(e);
            }
          });
          window.startPipDetachedAudio = async () => {
            const det = new window._pipWin.Audio(location.origin + '/tone.wav');
            det.loop = true;
            window._pipDetachedAudio = det;
            await det.play();
            return {connected: det.isConnected, rate: det.playbackRate};
          };
          window.getPipAudioState = () => ({
            opened: Boolean(window._pipOpened),
            error: window._pipError || null,
            paused: window._pipAudio?.paused,
            playbackRate: window._pipAudio?.playbackRate,
            volume: window._pipAudio?.volume,
            lightRate: window._pipLightAudio?.playbackRate,
            lightVol: window._pipLightAudio?.volume,
            detachedRate: window._pipDetachedAudio?.playbackRate,
            detachedVol: window._pipDetachedAudio?.volume,
            pipCaptureLeaks: window._pipCaptureLeaks,
            pipAutoPauseLeaks: window._pipAutoPauseLeaks
          });
          document.getElementById('openPip').addEventListener('contextmenu', async (ev) => {
            ev.preventDefault();
            try {
              const pipWin = await documentPictureInPicture.requestWindow({width: 320, height: 220});
              const port = location.port;
              const mkFrame = (src) => new Promise((resolve) => {
                const f = pipWin.document.createElement('iframe');
                f.allow = 'autoplay';
                f.onload = () => resolve(f);
                f.src = src;
                pipWin.document.body.appendChild(f);
              });
              const [crossF, sameF] = await Promise.all([
                mkFrame('http://127.0.0.1:' + port + '/pip-iframe?x'),
                mkFrame('http://localhost:' + port + '/pip-iframe?s')
              ]);
              window._pipWin2 = pipWin;
              window._pipCrossF = crossF;
              window._pipSameF = sameF;
              crossF.contentWindow.postMessage('play', '*');
              sameF.contentWindow.postMessage('play', '*');
              window._pipIframesOpened = true;
            } catch (e) {
              window._pipIframesErr = String(e);
            }
          });
          window.getPipIframesState = async () => {
            if (!window._pipIframesOpened) return {opened: false, error: window._pipIframesErr || null};
            const ask = (win, id) => new Promise((resolve) => {
              const h = (e) => {
                if (e.data && e.data.id === id) {
                  window.removeEventListener('message', h);
                  resolve(e.data);
                }
              };
              window.addEventListener('message', h);
              win.postMessage({cmd: 'state', id}, '*');
            });
            const [cross, same] = await Promise.all([
              ask(window._pipCrossF.contentWindow, 'cross'),
              ask(window._pipSameF.contentWindow, 'same')
            ]);
            return {
              opened: true,
              error: null,
              tokenInMainWorld: window._pipWin2[Symbol.for('autoPauseDocPiPToken')] || null,
              cross,
              same
            };
          };
        </script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/pip-iframe') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(`<!doctype html><html><body>
        <audio id="ia" src="/tone.wav" loop></audio>
        <script>
          const a = document.getElementById('ia');
          window.addEventListener('message', async (e) => {
            if (e.data === 'play') await a.play();
            if (e.data && e.data.cmd === 'state') {
              e.source.postMessage({id: e.data.id, paused: a.paused, rate: a.playbackRate, vol: a.volume}, '*');
            }
          });
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopause-chrome-'));
  try {
    // =========================================================================
    // PHASE A: Exact unmodified Chrome build from builds.yml
    // =========================================================================
    console.log('=== PHASE A: Exact unmodified Chrome extension build ===');
    const extDirA = path.join(tmpRoot, 'ext-a');
    const profDirA = path.join(tmpRoot, 'prof-a');
    buildChromeExt(extDirA, null);

    const browserA = await launchChromium(
      extDirA,
      profDirA,
      await getFreePort()
    );
    try {
      const {cdp} = browserA;
      // Wait for AutoPause service worker
      const swTarget = await waitFor(async () => {
        const {targetInfos} = await cdp.send('Target.getTargets');
        return targetInfos.find(
          (t) => t.type === 'service_worker' && t.url.endsWith('/background.js')
        );
      }, 10000);
      const extId = new URL(swTarget.url).hostname;
      console.log('1. Extension SW loaded:', swTarget.url);

      const {sessionId: swSid} = await cdp.send('Target.attachToTarget', {
        targetId: swTarget.targetId,
        flatten: true
      });
      const swErrors = [];
      cdp.on(
        'Runtime.exceptionThrown',
        (p) => swErrors.push(p.exceptionDetails?.text),
        swSid
      );
      await cdp.send('Runtime.enable', {}, swSid);

      // Wait for initialization & onInstalled (which opens options.html!)
      let optionsTarget;
      try {
        optionsTarget = await waitFor(async () => {
          const {targetInfos} = await cdp.send('Target.getTargets', {
            filter: [{exclude: false}]
          });
          return targetInfos.find(
            (t) => t.url === `chrome-extension://${extId}/options.html`
          );
        }, 15000);
      } catch (err) {
        const {targetInfos} = await cdp.send('Target.getTargets', {
          filter: [{exclude: false}]
        });
        const tabs = await evalInSession(
          cdp,
          swSid,
          `chrome.tabs.query({}).then((ts) => ts.map((t) => ({id: t.id, url: t.url, pendingUrl: t.pendingUrl, status: t.status})))`
        ).catch((e) => String(e));
        console.error(
          'Phase A options.html diagnostic:',
          JSON.stringify(
            {
              targets: targetInfos.map((t) => ({type: t.type, url: t.url})),
              tabs,
              swErrors,
              chromeLogs: browserA.getLogs().slice(-2000)
            },
            null,
            2
          )
        );
        throw err;
      }
      console.log(
        '2. onInstalled auto-opened options.html:',
        optionsTarget.url
      );

      const {sessionId: optSid} = await cdp.send('Target.attachToTarget', {
        targetId: optionsTarget.targetId,
        flatten: true
      });
      const optErrors = [];
      const optConsoleErrors = [];
      cdp.on(
        'Runtime.exceptionThrown',
        (p) => optErrors.push(p.exceptionDetails?.text),
        optSid
      );
      cdp.on(
        'Log.entryAdded',
        (p) => {
          if (p.entry.level === 'error') optConsoleErrors.push(p.entry.text);
        },
        optSid
      );
      await cdp.send('Runtime.enable', {}, optSid);
      await cdp.send('Log.enable', {}, optSid);
      await sleep(500);

      // Verify options.css applied under hardened CSP & options-chrome.js ran
      const optState = await evalInSession(
        cdp,
        optSid,
        `(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        color: getComputedStyle(document.body).color,
        chromeOnlyHidden: document.getElementById('chromeonly').hidden,
        shortcutButtons: document.querySelectorAll('#shortcuts button').length
      }))()`
      );
      console.log('3. Options page computed state:', optState);
      assert.equal(
        optState.bg,
        'rgb(27, 38, 44)',
        'options.css background-color must apply under CSP'
      );
      assert.equal(
        optState.color,
        'rgb(255, 255, 255)',
        'options.css color must apply under CSP'
      );
      assert.equal(
        optState.chromeOnlyHidden,
        false,
        'options-chrome.js must unhide #chromeonly'
      );
      assert.equal(
        optState.shortcutButtons,
        1,
        'options-chrome.js must add Edit shortcuts button'
      );

      // Toggle an option checkbox and verify sync storage + background.js picks it up
      await evalInSession(
        cdp,
        optSid,
        `document.getElementById('muteonpause').click()`
      );
      await sleep(300);
      const bgHasMute = await evalInSession(
        cdp,
        swSid,
        `Object.prototype.hasOwnProperty.call(options, 'muteonpause')`
      );
      assert.equal(
        bgHasMute,
        true,
        'background.js must receive muteonpause option change from sync storage'
      );
      console.log(
        '4. Options checkbox -> chrome.storage.sync -> background.js verified!'
      );

      assert.equal(swErrors.length, 0, `SW errors: ${swErrors}`);
      assert.equal(optErrors.length, 0, `Options runtime errors: ${optErrors}`);
      assert.equal(
        optConsoleErrors.length,
        0,
        `Options console/CSP errors: ${optConsoleErrors}`
      );
      console.log('5. ZERO errors & ZERO CSP violations in Phase A!\n');
    } finally {
      await browserA.stop();
    }

    // =========================================================================
    // PHASE B: Live audio, Shadow DOM, DOM Clobbering, Untrusted Events,
    //          Document PiP, Detached Audio, and Storage TRUSTED_CONTEXTS
    // =========================================================================
    console.log(
      '=== PHASE B: Live browser playback, Shadow DOM, Clobbering, PiP, Storage ==='
    );
    const {server, port: httpPort} = await startTestServer();
    const extDirB = path.join(tmpRoot, 'ext-b');
    const profDirB = path.join(tmpRoot, 'prof-b');
    buildChromeExt(extDirB, ['http://127.0.0.1/*', 'http://localhost/*']);

    const browserB = await launchChromium(
      extDirB,
      profDirB,
      await getFreePort()
    );
    try {
      const {cdp} = browserB;
      const swTarget = await waitFor(async () => {
        const {targetInfos} = await cdp.send('Target.getTargets');
        return targetInfos.find(
          (t) => t.type === 'service_worker' && t.url.endsWith('/background.js')
        );
      }, 10000);
      const {sessionId: swSid} = await cdp.send('Target.attachToTarget', {
        targetId: swTarget.targetId,
        flatten: true
      });
      const swErrors = [];
      cdp.on(
        'Runtime.exceptionThrown',
        (p) => swErrors.push(p.exceptionDetails?.text),
        swSid
      );
      await cdp.send('Runtime.enable', {}, swSid);

      // Wait for registerContentScripts to finish
      await waitFor(async () => {
        const scripts = await evalInSession(
          cdp,
          swSid,
          `chrome.scripting.getRegisteredContentScripts().then(s => s.map(x => x.id))`
        );
        return scripts.includes('ContentScript') &&
          scripts.includes('WindowScript')
          ? scripts
          : null;
      }, 10000);
      console.log('1. Dynamic ContentScript & WindowScript registered cleanly');

      // Helper to open a tab and return {targetId, sessionId, errors}
      async function openTab(url) {
        const {targetId} = await cdp.send('Target.createTarget', {url});
        const {sessionId} = await cdp.send('Target.attachToTarget', {
          targetId,
          flatten: true
        });
        const errors = [];
        cdp.on(
          'Runtime.exceptionThrown',
          (p) =>
            errors.push(
              p.exceptionDetails?.text +
                ' ' +
                (p.exceptionDetails?.exception?.description || '')
            ),
          sessionId
        );
        await cdp.send('Runtime.enable', {}, sessionId);
        await cdp.send('Page.enable', {}, sessionId);
        await waitFor(
          () =>
            evalInSession(cdp, sessionId, `document.readyState === 'complete'`),
          10000
        );
        await sleep(300);
        return {targetId, sessionId, errors};
      }

      // --- Test 2: Tab 1 (normal) vs Tab 2 (closed Shadow DOM + DOM clobbering + synthetic events) ---
      const tab1 = await openTab(`http://127.0.0.1:${httpPort}/normal`);
      const tab2 = await openTab(
        `http://127.0.0.1:${httpPort}/shadow-and-clobber`
      );

      // Verify WindowScript ran in MAIN world on Tab 1
      const wsFlag = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.autoPauseExtensionInjected`
      );
      assert.equal(
        wsFlag,
        true,
        'WindowScript must set autoPauseExtensionInjected'
      );

      // Activate Tab 1 and play audio
      await cdp.send('Target.activateTarget', {targetId: tab1.targetId});
      await sleep(200);
      await evalInSession(cdp, tab1.sessionId, `window.playAudio()`);

      // Wait until Chromium reports Tab 1 audible and AutoPause tracks it
      await waitFor(async () => {
        const st = await evalInSession(
          cdp,
          swSid,
          `({mediaPlaying: state.mediaPlaying, mediaSize: state.media.size})`
        );
        return st.mediaPlaying !== null && st.mediaSize >= 1 ? st : null;
      }, 10000);
      const t1PlayingId = await evalInSession(cdp, swSid, `state.mediaPlaying`);
      console.log(
        '2. Tab 1 playing audio tracked as mediaPlaying =',
        t1PlayingId
      );

      // --- Test 3: Synthetic untrusted events on background Tab 2 must be ignored ---
      const spoofRes = await evalInSession(
        cdp,
        tab2.sessionId,
        `window.spoofEvents()`
      );
      await sleep(400);
      const stateAfterSpoof = await evalInSession(
        cdp,
        swSid,
        `({mediaPlaying: state.mediaPlaying, mediaSize: state.media.size})`
      );
      assert.equal(
        stateAfterSpoof.mediaPlaying,
        t1PlayingId,
        'Untrusted play/pagehide must NOT hijack mediaPlaying'
      );
      assert.equal(
        stateAfterSpoof.mediaSize,
        1,
        'Untrusted play must NOT add spoofed tab to state.media'
      );
      console.log(
        '3. Untrusted synthetic play/durationchange/pagehide/visibilitychange ignored! (spoof duration =',
        spoofRes.duration,
        ')'
      );

      // --- Test 4: Activate Tab 2 (which has ALL 3 DOM-clobbering payloads + closed ShadowRoot player!) ---
      await cdp.send('Target.activateTarget', {targetId: tab2.targetId});
      await sleep(200);
      await evalInSession(cdp, tab2.sessionId, `window.playShadow()`);

      // Tab 1 should get auto-paused (playbackRate === 0, volume === 0) WITHOUT notifying page volumechange/ratechange listeners!
      const t1PausedState = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getAudioState()`
        );
        return s.playbackRate === 0 && s.volume === 0 ? s : null;
      }, 10000);
      await sleep(150);
      const t1AfterPauseCheck = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.getAudioState()`
      );
      assert.equal(
        t1AfterPauseCheck.pageSawZeroVolume,
        0,
        'Page volumechange listener must NOT see temporary volume=0'
      );
      assert.equal(
        t1AfterPauseCheck.pageSawZeroRate,
        0,
        'Page ratechange listener must NOT see temporary playbackRate=0'
      );
      assert.equal(
        t1AfterPauseCheck.captureLeakCount,
        0,
        'window/document/body/target capture listeners must NOT see temporary volume=0 or playbackRate=0'
      );
      const muteFlips = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.testMuteUnmuteWhilePaused()`
      );
      assert.equal(
        muteFlips.length,
        2,
        `Both Mute and Unmute while auto-paused must reach page: ${JSON.stringify(muteFlips)}`
      );
      assert.equal(muteFlips[0].muted, true);
      assert.equal(muteFlips[1].muted, false);

      // Denied background watchdog rate-reset: volume must NEVER leave 0 and rate must snap back to 0!
      await evalInSession(
        cdp,
        tab1.sessionId,
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
        const s = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getAudioState()`
        );
        return s.playbackRate === 0 && s.volume === 0 ? s : null;
      }, 5000);
      await sleep(150);
      const maxVolDenied = await evalInSession(
        cdp,
        tab1.sessionId,
        `(() => { window._cleanupDeniedReset(); return window._maxVolDuringDeniedReset; })()`
      );
      assert.equal(
        maxVolDenied,
        0,
        'Denied background playbackRate reset must NEVER restore volume > 0'
      );
      assert.equal(
        (await evalInSession(cdp, tab1.sessionId, `window.getAudioState()`))
          .captureLeakCount,
        0
      );
      console.log(
        '4. Closed Shadow DOM audio on clobbered page auto-paused Tab 1 (capture/bubble hidden, Mute->Unmute passed through, denied rate-reset stayed silent):',
        t1AfterPauseCheck,
        muteFlips
      );

      // Pause Tab 2 -> Tab 1 should auto-resume!
      await evalInSession(cdp, tab2.sessionId, `window.pauseShadow()`);
      const t1ResumedState = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getAudioState()`
        );
        return s.playbackRate === 1 && s.volume === 1 ? s : null;
      }, 10000);
      console.log(
        '5. Pausing Shadow DOM audio auto-resumed Tab 1:',
        t1ResumedState
      );

      // Test overlapping pause->play->pause->play debounce race: Tab 1 must stay tracked & auto-pause cleanly!
      await cdp.send('Target.activateTarget', {targetId: tab1.targetId});
      await sleep(150);
      const debounceRes = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.testOverlappingPauseDebounce()`
      );
      assert.equal(debounceRes.paused, false);
      assert.equal(debounceRes.playbackRate, 1);

      // Test muted <video> paused & resumed via AutoPause (on visible Tab 1 so Chromium's own
      // background muted-media pause doesn't race the test) + user volume change while auto-paused!
      await evalInSession(cdp, tab1.sessionId, `window.startMutedMedia()`);
      await sleep(200);
      await evalInSession(cdp, swSid, `pauseAll()`);
      await waitFor(async () => {
        const m = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getMutedMediaState()`
        );
        const a = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getAudioState()`
        );
        return m.playbackRate === 0 && a.playbackRate === 0 && a.volume === 0
          ? {m, a}
          : null;
      }, 10000);
      await sleep(100);
      const mutedAfter = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.getMutedMediaState()`
      );
      assert.equal(
        mutedAfter.paused,
        false,
        'Muted media must stay unpaused on visible tab'
      );
      assert.equal(
        mutedAfter.volume,
        0.8,
        'Muted media volume must stay 0.8 when auto-paused'
      );
      assert.equal(
        mutedAfter.volChanges,
        0,
        'Muted media must fire ZERO volumechange events when auto-paused'
      );
      assert.equal(
        mutedAfter.msVol,
        0.7,
        'Muted MediaStream volume must stay 0.7 when auto-paused'
      );
      assert.equal(
        mutedAfter.msEvents.length,
        0,
        'Muted MediaStream must fire ZERO volumechange events when auto-paused'
      );

      // Unmuting a muted WebRTC MediaStream while still auto-paused must immediately silence it (volume=0)
      // and suppress the follow-up volume=0 event (only 1 event for muted=false)!
      const msUnmuted = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.unmuteStreamWhilePaused()`
      );
      assert.equal(msUnmuted.msMuted, false);
      assert.equal(
        msUnmuted.msVol,
        0,
        'Unmuted MediaStream while auto-paused must be silenced to volume=0'
      );
      assert.equal(
        msUnmuted.msEvents.length,
        1,
        `Unmuted MediaStream must fire only 1 volumechange (muted=false): ${JSON.stringify(msUnmuted.msEvents)}`
      );

      // User drags unmuted audio volume 0 -> 0.4 -> 0 while auto-paused -> BOTH events must reach page & resume must stay at 0!
      const dragEvents = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.dragVolumeToZeroWhilePaused()`
      );
      assert.equal(
        dragEvents.length,
        2,
        `Both 0->0.4 and 0.4->0 events must reach page: ${JSON.stringify(dragEvents)}`
      );
      assert.equal(dragEvents[0].volume, 0.4);
      assert.equal(dragEvents[1].volume, 0);

      await evalInSession(cdp, swSid, `play(${t1PlayingId})`);
      await waitFor(async () => {
        const m = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getMutedMediaState()`
        );
        const a = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getAudioState()`
        );
        return m.playbackRate === 1 && a.playbackRate === 1 ? {m, a} : null;
      }, 10000);
      await sleep(100);
      const mutedAfterResume = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.getMutedMediaState()`
      );
      const audioAfterResume = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.getAudioState()`
      );
      assert.equal(
        mutedAfterResume.volume,
        0.8,
        'Muted media volume must stay 0.8 when resumed'
      );
      assert.equal(
        mutedAfterResume.volChanges,
        0,
        'Muted media must fire ZERO volumechange events across pause+resume'
      );
      assert.equal(
        mutedAfterResume.msVol,
        0.7,
        'Unmuted MediaStream volume must restore to 0.7 on resume'
      );
      assert.equal(
        audioAfterResume.volume,
        0,
        'User volume drag 0->0.4->0 while auto-paused must stay 0 on resume'
      );

      // Allowed active-tab rate-reset (1.5x) while auto-paused -> background sends normalPlayback,
      // restoring volume=1 & keeping playbackRate=1.5 without waking sibling paused elements!
      await evalInSession(
        cdp,
        tab1.sessionId,
        `document.getElementById('a').volume = 1`
      );
      await sleep(100);
      await evalInSession(cdp, swSid, `pauseAll()`);
      await waitFor(async () => {
        const m = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getMutedMediaState()`
        );
        const a = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getAudioState()`
        );
        return m.playbackRate === 0 && a.playbackRate === 0 && a.volume === 0
          ? {m, a}
          : null;
      }, 10000);
      await evalInSession(
        cdp,
        tab1.sessionId,
        `document.getElementById('a').playbackRate = 1.5`
      );
      const rateRestored = await waitFor(async () => {
        const a = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getAudioState()`
        );
        return a.volume === 1 ? a : null;
      }, 5000);
      await sleep(100);
      const siblingAfterRateReset = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.getMutedMediaState()`
      );
      assert.equal(
        rateRestored.playbackRate,
        1.5,
        'normalPlayback must preserve new playbackRate=1.5'
      );
      assert.equal(
        siblingAfterRateReset.playbackRate,
        0,
        'normalPlayback must NOT wake sibling paused elements at rate=0'
      );
      assert.equal(
        siblingAfterRateReset.msVol,
        0,
        'normalPlayback must NOT unmute sibling auto-paused MediaStream whose playbackRate stayed 1'
      );
      await evalInSession(
        cdp,
        tab1.sessionId,
        `document.getElementById('a').playbackRate = 1; window.pauseAudio(); window.stopMutedMedia()`
      );
      await sleep(350);
      console.log(
        '5b. Muted media (0.8, 0 events), MediaStream unmute (0->0.7), 0->0.4->0 drag (stays 0), and allowed rate-reset (1.5x + vol=1, sibling stayed 0) ALL verified!'
      );

      // Test full detached-media matrix via FocusEvent.relatedTarget (ZERO DOM mutations!)
      const matrixInit = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.startDetachedMatrix()`
      );
      assert.equal(
        matrixInit.headChildren,
        0,
        'WindowScript must NOT mutate document.head'
      );
      assert.equal(
        matrixInit.pageSawAutoPauseEvent,
        0,
        'Page listeners must NOT see autoPauseMedia'
      );
      assert.equal(
        matrixInit.a1Detached,
        true,
        'a1 must remain detached with parentNode=null'
      );
      assert.equal(
        matrixInit.a2Intact,
        true,
        'a2 must stay inside its detached div wrapper'
      );
      assert.equal(
        matrixInit.a3Intact,
        true,
        'a3 must stay inside its detached DocumentFragment'
      );
      assert.equal(
        matrixInit.a4Detached,
        true,
        'a4 must stay detached inside closed ShadowRoot'
      );
      assert.equal(
        matrixInit.srcdocWs,
        true,
        'WindowScript must inject into about:srcdoc iframe'
      );
      assert.equal(
        matrixInit.blobWs,
        true,
        'WindowScript must inject into blob: iframe'
      );
      assert.equal(
        matrixInit.sandboxWs,
        true,
        'WindowScript must inject into sandbox="allow-scripts" iframe'
      );
      assert.equal(
        matrixInit.a8Connected,
        true,
        'a8 must be a connected nested closed ShadowRoot audio'
      );

      // Play Tab 2 -> ALL elements (a1..a8 including srcdoc, blob, & connected nested closed ShadowRoot) on Tab 1 must be auto-paused!
      await cdp.send('Target.activateTarget', {targetId: tab2.targetId});
      await sleep(200);
      await evalInSession(cdp, tab2.sessionId, `window.playShadow()`);
      const matrixPaused = await waitFor(async () => {
        const r = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getMatrixRates()`
        );
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
        '6a. Detached + connected nested ShadowRoot matrix (a1..a8) auto-paused by Tab 2:',
        matrixPaused,
        'init:',
        matrixInit
      );

      // Pause Tab 2 -> ALL elements must auto-resume!
      await evalInSession(cdp, tab2.sessionId, `window.pauseShadow()`);
      const matrixResumed = await waitFor(async () => {
        const r = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getMatrixRates()`
        );
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

      // Pause a2..a5, then pause & REPLAY a1 to verify WeakSet/re-play lifecycle, keeping a1 playing for DocPiP test
      await cdp.send('Target.activateTarget', {targetId: tab1.targetId});
      await evalInSession(cdp, tab1.sessionId, `window.pauseMatrixExceptA1()`);
      await evalInSession(cdp, tab1.sessionId, `window.replayA1()`);
      const detState = await evalInSession(
        cdp,
        tab1.sessionId,
        `window.getDetachedState()`
      );
      assert.equal(
        detState.isConnected,
        false,
        'Replayed detached Audio must stay detached'
      );
      assert.equal(detState.parentNode, null);
      console.log(
        '6b. Detached matrix resumed & a1 replayed cleanly with zero DOM mutation:',
        detState
      );

      // --- Test 5: Verify chrome.storage.sync is BLOCKED from ContentScript isolated world (Chromium 156!) ---
      const isolatedWorldCtx = await new Promise((resolve) => {
        const contexts = [];
        cdp.on(
          'Runtime.executionContextCreated',
          (p) => contexts.push(p.context),
          tab1.sessionId
        );
        cdp
          .send('Runtime.disable', {}, tab1.sessionId)
          .then(() => cdp.send('Runtime.enable', {}, tab1.sessionId))
          .then(() => sleep(300))
          .then(() =>
            resolve(
              contexts.find(
                (c) => c.auxData?.isDefault === false && c.name === 'AutoPause'
              )
            )
          );
      });
      assert.ok(
        isolatedWorldCtx,
        'Should find AutoPause isolated world execution context'
      );
      const storageAccessResult = await cdp.send(
        'Runtime.evaluate',
        {
          contextId: isolatedWorldCtx.id,
          expression: `chrome.storage.sync.get('options').then(() => 'ALLOWED', (e) => 'BLOCKED: ' + e.message)`,
          awaitPromise: true,
          returnByValue: true
        },
        tab1.sessionId
      );
      const storageResStr = storageAccessResult.result?.value;
      console.log(
        '7. chrome.storage.sync.get() from ContentScript isolated world:',
        storageResStr
      );
      assert.ok(
        typeof storageResStr === 'string' &&
          storageResStr.startsWith('BLOCKED:'),
        `Expected TRUSTED_CONTEXTS block in Chromium 156, got: ${storageResStr}`
      );

      // Verify re-injecting ContentScript.js into tab1 does NOT throw or duplicate listeners!
      const reinjectErr = await evalInSession(
        cdp,
        swSid,
        `chrome.tabs.query({url: 'http://127.0.0.1/*'}).then(async (tabs) => {
        await chrome.scripting.executeScript({target: {tabId: tabs[0].id, allFrames: true}, files: ['ContentScript.js']});
        return 'OK';
      })`
      );
      assert.equal(reinjectErr, 'OK');
      console.log(
        '8. Programmatic re-injection of ContentScript.js succeeded cleanly (IIFE guard)!'
      );

      // --- Test 6: Document Picture-in-Picture on http://localhost (SecureContext!) ---
      const tab3 = await openTab(`http://localhost:${httpPort}/docpip`);
      await cdp.send('Target.activateTarget', {targetId: tab3.targetId});
      await sleep(300);
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );

      const pipState = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab3.sessionId,
          `window.getPipAudioState()`
        );
        return s.opened || s.error ? s : null;
      }, 8000);
      assert.equal(
        pipState.error,
        null,
        `Document PiP failed: ${pipState.error}`
      );
      assert.equal(pipState.opened, true, 'Document PiP must open');

      // Wait past BOTH pipTab audible:true (~70ms) AND windows.onFocusChanged (200ms) to verify NO self-pause & activeTab preserved!
      const tab3Id = await evalInSession(
        cdp,
        swSid,
        `chrome.tabs.query({url: 'http://localhost/*'}).then(t => t[0]?.id)`
      );
      await sleep(600);
      const pipStable = await evalInSession(
        cdp,
        tab3.sessionId,
        `window.getPipAudioState()`
      );
      const swPip = await evalInSession(
        cdp,
        swSid,
        `({activeTab: state.activeTab, mediaPlaying: state.mediaPlaying, media: [...state.media], otherTabs: [...state.otherTabs]})`
      );
      assert.equal(
        pipStable.playbackRate,
        1,
        `DocPiP shadow audio self-paused! ${JSON.stringify({pipStable, swPip})}`
      );
      assert.equal(
        pipStable.volume,
        1,
        `DocPiP shadow volume zeroed! ${JSON.stringify({pipStable, swPip})}`
      );
      assert.equal(
        pipStable.lightRate,
        1,
        `DocPiP light audio self-paused! ${JSON.stringify({pipStable, swPip})}`
      );
      assert.equal(
        pipStable.lightVol,
        1,
        `DocPiP light volume zeroed! ${JSON.stringify({pipStable, swPip})}`
      );
      assert.equal(
        swPip.activeTab,
        tab3Id,
        `windows.onFocusChanged clobbered activeTab! ${JSON.stringify(swPip)}`
      );
      assert.equal(
        swPip.mediaPlaying,
        tab3Id,
        `pipTab hijacked mediaPlaying! ${JSON.stringify(swPip)}`
      );
      assert.equal(
        swPip.otherTabs.length,
        0,
        `pipTab leaked into otherTabs! ${JSON.stringify(swPip)}`
      );

      // Verify spoofed tabFocus from a background tab is REJECTED (cannot steal state.activeTab)
      await cdp.send(
        'Runtime.evaluate',
        {
          contextId: isolatedWorldCtx.id,
          expression: `chrome.runtime.sendMessage({type: 'tabFocus'})`,
          awaitPromise: false
        },
        tab1.sessionId
      );
      await sleep(200);
      const activeAfterSpoof = await evalInSession(
        cdp,
        swSid,
        `state.activeTab`
      );
      assert.equal(
        activeAfterSpoof,
        tab3Id,
        `Spoofed tabFocus from background tab stole activeTab: ${activeAfterSpoof}`
      );
      console.log(
        '9. Document PiP stable (no self-pause, activeTab/mediaPlaying preserved, spoofed tabFocus blocked):',
        {pipStable, swPip}
      );

      // Verify Tab 1's detached audio got auto-paused when Document PiP played!
      const detPausedByPip = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab1.sessionId,
          `window.getDetachedState()`
        );
        return s.playbackRate === 0 && s.volume === 0 ? s : null;
      }, 10000);
      console.log(
        '10. Document PiP audio auto-paused Tab 1 detached audio:',
        detPausedByPip
      );

      // Start detached new pipWin.Audio() inside Document PiP (after enter) and verify opener tracks it with 0 autoPauseMedia leaks!
      const pipDetInit = await evalInSession(
        cdp,
        tab3.sessionId,
        `window.startPipDetachedAudio()`
      );
      assert.equal(
        pipDetInit.connected,
        false,
        'pipWin detached Audio must remain detached'
      );

      // Play Tab 2 -> closed-shadow, light-DOM, AND detached new pipWin.Audio() in DocPiP must auto-pause with 0 leaks!
      await cdp.send('Target.activateTarget', {targetId: tab2.targetId});
      await sleep(200);
      await evalInSession(cdp, tab2.sessionId, `window.playShadow()`);
      let pipPaused;
      try {
        pipPaused = await waitFor(async () => {
          const s = await evalInSession(
            cdp,
            tab3.sessionId,
            `window.getPipAudioState()`
          );
          return s.playbackRate === 0 &&
            s.lightRate === 0 &&
            s.lightVol === 0 &&
            s.detachedRate === 0 &&
            s.detachedVol === 0
            ? s
            : null;
        }, 4000);
      } catch (e) {
        const diag = {
          pip: await evalInSession(
            cdp,
            tab3.sessionId,
            `window.getPipAudioState()`
          ),
          sw: await evalInSession(
            cdp,
            swSid,
            `({media: [...state.media], otherTabs: [...state.otherTabs], mediaPlaying: state.mediaPlaying, activeTab: state.activeTab})`
          )
        };
        throw new Error(`${e.message} | diag=${JSON.stringify(diag)}`);
      }
      await sleep(150);
      const pipAfterPause = await evalInSession(
        cdp,
        tab3.sessionId,
        `window.getPipAudioState()`
      );
      assert.equal(
        pipAfterPause.pipCaptureLeaks,
        0,
        `DocPiP pipWin/document/target capture listeners must NOT see 0: ${JSON.stringify(pipAfterPause)}`
      );
      assert.equal(
        pipAfterPause.pipAutoPauseLeaks,
        0,
        `DocPiP page must NOT see autoPauseMedia event: ${JSON.stringify(pipAfterPause)}`
      );
      console.log(
        '10b. Document PiP shadow + light + detached pipWin.Audio auto-paused with 0 leaks:',
        pipAfterPause
      );

      // Close DocPiP window without calling .pause() -> opener's Elements & state.media must clean up cleanly!
      await evalInSession(cdp, tab3.sessionId, `window._pipWin.close()`);
      const tab3Cleaned = await waitFor(async () => {
        const stillPlaying = await evalInSession(
          cdp,
          swSid,
          `isPlaying(${tab3Id})`
        );
        const inMedia = await evalInSession(
          cdp,
          swSid,
          `state.media.has(${tab3Id})`
        );
        return !stillPlaying && !inMedia ? {stillPlaying, inMedia} : null;
      }, 5000);
      console.log(
        '10c. Closing Document PiP cleaned up opener Elements & removed tab from state.media:',
        tab3Cleaned
      );

      // Verify src = '' + load() teardown (fires only 'emptied', no 'pause'/'abort') cleans up Elements & state.media!
      await cdp.send('Target.activateTarget', {targetId: tab3.targetId});
      await sleep(150);
      await evalInSession(
        cdp,
        tab3.sessionId,
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
        () => evalInSession(cdp, swSid, `state.media.has(${tab3Id})`),
        5000
      );
      await evalInSession(
        cdp,
        tab3.sessionId,
        `(() => { window._emptiedAudio.src = ''; window._emptiedAudio.load(); })()`
      );
      const emptiedCleaned = await waitFor(async () => {
        const stillPlaying = await evalInSession(
          cdp,
          swSid,
          `isPlaying(${tab3Id})`
        );
        const inMedia = await evalInSession(
          cdp,
          swSid,
          `state.media.has(${tab3Id})`
        );
        return !stillPlaying && !inMedia ? {stillPlaying, inMedia} : null;
      }, 5000);
      console.log(
        '10d. src=\"\" + load() teardown cleaned up Elements & state.media via emptied:',
        emptiedCleaned
      );

      // 10e. Cross-origin + same-origin iframes inside Document PiP (NO top-doc audio!)
      await cdp.send('Target.activateTarget', {targetId: tab3.targetId});
      await sleep(200);
      // Pause Tab 2 if still playing, start Tab 1 detached audio to verify DocPiP iframe pauses Tab 1
      await evalInSession(cdp, tab2.sessionId, `window.pauseShadow()`);
      await sleep(300);
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mousePressed', x: 50, y: 50, button: 'right', clickCount: 1},
        tab3.sessionId
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mouseReleased', x: 50, y: 50, button: 'right', clickCount: 1},
        tab3.sessionId
      );
      await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab3.sessionId,
          `window.getPipIframesState()`
        );
        return s.opened || s.error ? s : null;
      }, 8000);
      await sleep(700);
      const ifrPlaying = await evalInSession(
        cdp,
        tab3.sessionId,
        `window.getPipIframesState()`
      );
      const swIfr = await evalInSession(
        cdp,
        swSid,
        `(async () => ({activeTab: state.activeTab, mediaPlaying: state.mediaPlaying, media: [...state.media], otherTabs: [...state.otherTabs], pipTabs: state.pipTabs, isPlaying: await isPlaying(${tab3Id})}))()`
      );
      assert.equal(
        ifrPlaying.error,
        null,
        `DocPiP iframes failed: ${ifrPlaying.error}`
      );
      assert.equal(
        ifrPlaying.tokenInMainWorld,
        null,
        'pipToken must NOT be readable from MAIN world'
      );
      assert.equal(
        ifrPlaying.cross.rate,
        1,
        `Cross-origin iframe in DocPiP self-paused! ${JSON.stringify({ifrPlaying, swIfr})}`
      );
      assert.equal(ifrPlaying.cross.vol, 1);
      assert.equal(
        ifrPlaying.same.rate,
        1,
        `Same-origin iframe in DocPiP self-paused! ${JSON.stringify({ifrPlaying, swIfr})}`
      );
      assert.equal(ifrPlaying.same.vol, 1);
      assert.equal(
        swIfr.activeTab,
        tab3Id,
        `activeTab wrong for DocPiP iframes: ${JSON.stringify(swIfr)}`
      );
      assert.equal(
        swIfr.mediaPlaying,
        tab3Id,
        `mediaPlaying wrong for DocPiP iframes: ${JSON.stringify(swIfr)}`
      );
      assert.equal(
        swIfr.otherTabs.length,
        0,
        `otherTabs leaked for DocPiP iframes: ${JSON.stringify(swIfr)}`
      );
      assert.equal(
        swIfr.isPlaying,
        true,
        `isPlaying(tab3Id) must be true via forwarded pipTab query: ${JSON.stringify(swIfr)}`
      );
      const pipEntries10e = Object.values(swIfr.pipTabs);
      assert.equal(
        pipEntries10e.length,
        1,
        `Expected 1 pipTabs entry: ${JSON.stringify(swIfr.pipTabs)}`
      );
      assert.equal(
        pipEntries10e[0].openerTabId,
        tab3Id,
        `pipTabs openerTabId mismatch: ${JSON.stringify(pipEntries10e[0])}`
      );
      assert.equal(
        typeof pipEntries10e[0].openerDocumentId,
        'string',
        `openerDocumentId must be pinned: ${JSON.stringify(pipEntries10e[0])}`
      );
      assert.equal(
        typeof pipEntries10e[0].pipDocumentId,
        'string',
        `pipDocumentId must be pinned: ${JSON.stringify(pipEntries10e[0])}`
      );

      // Play Tab 2 -> BOTH cross-origin & same-origin iframes in DocPiP must auto-pause!
      await cdp.send('Target.activateTarget', {targetId: tab2.targetId});
      await sleep(200);
      await evalInSession(cdp, tab2.sessionId, `window.playShadow()`);
      const ifrPaused = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab3.sessionId,
          `window.getPipIframesState()`
        );
        return s.cross.rate === 0 &&
          s.cross.vol === 0 &&
          s.same.rate === 0 &&
          s.same.vol === 0
          ? s
          : null;
      }, 6000);

      // Pause Tab 2 -> BOTH iframes in DocPiP must auto-resume!
      await evalInSession(cdp, tab2.sessionId, `window.pauseShadow()`);
      const ifrResumed = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab3.sessionId,
          `window.getPipIframesState()`
        );
        return s.cross.rate === 1 &&
          s.cross.vol === 1 &&
          s.same.rate === 1 &&
          s.same.vol === 1
          ? s
          : null;
      }, 6000);

      // Track hidden messages from pipTab during close
      const pipId10e = Number(Object.keys(swIfr.pipTabs)[0]);
      await evalInSession(
        cdp,
        swSid,
        `(() => {
        self.__pipHiddenMsgs = [];
        self.__pipHiddenListener = (msg, sender) => {
          if (msg?.type === 'hidden' && sender.tab?.id === ${pipId10e} && sender.frameId === 0) {
            self.__pipHiddenMsgs.push(sender.url);
          }
        };
        chrome.runtime.onMessage.addListener(self.__pipHiddenListener);
        return true;
      })()`
      );

      // Close DocPiP -> state.pipTabs & opener state.media must clean up cleanly via remove()!
      await evalInSession(cdp, tab3.sessionId, `window._pipWin2.close()`);
      const ifrCleaned = await waitFor(async () => {
        const stillPlaying = await evalInSession(
          cdp,
          swSid,
          `isPlaying(${tab3Id})`
        );
        const inMedia = await evalInSession(
          cdp,
          swSid,
          `state.media.has(${tab3Id})`
        );
        const pipCount = await evalInSession(
          cdp,
          swSid,
          `Object.keys(state.pipTabs).length`
        );
        return !stillPlaying && !inMedia && pipCount === 0
          ? {stillPlaying, inMedia, pipCount}
          : null;
      }, 6000);
      const pipHiddenCount = await evalInSession(
        cdp,
        swSid,
        `(() => { chrome.runtime.onMessage.removeListener(self.__pipHiddenListener); return self.__pipHiddenMsgs.length; })()`
      );
      assert.equal(
        pipHiddenCount,
        0,
        `pipWin top frame must NOT send hidden on close!`
      );
      console.log(
        '10e. Cross-origin + same-origin iframes inside DocPiP verified (document-pinned, play, auto-pause, auto-resume, close cleanup, 0 pipWin hidden leaks):',
        {ifrPlaying, ifrPaused, ifrResumed, ifrCleaned}
      );

      // 10f. Hardened Document PiP routing & security suite:
      // (a) pauseoninactive + disableresume when opening Document PiP must NOT pause opener video!
      await cdp.send('Target.activateTarget', {targetId: tab3.targetId});
      await sleep(250);
      await evalInSession(
        cdp,
        swSid,
        `options.pauseoninactive = true; options.disableresume = true; true`
      );
      await evalInSession(
        cdp,
        tab3.sessionId,
        `(async () => {
        const a = document.createElement('audio');
        a.src = '/tone.wav?opener10f';
        a.loop = true;
        document.body.appendChild(a);
        window._opener10f = a;
        await a.play();
      })()`,
        true
      );
      await waitFor(
        () =>
          evalInSession(
            cdp,
            swSid,
            `state.mediaPlaying === ${tab3Id} && state.media.has(${tab3Id})`
          ),
        5000
      );
      // Open Document PiP AND immediately play a pipWin-created audio BEFORE 'enter' fires (tests 4ms pre-enter gap + pauseoninactive+disableresume!)
      await evalInSession(
        cdp,
        tab3.sessionId,
        `(() => {
        window._pip3Ready = false;
        const btn = document.createElement('button');
        btn.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;z-index:999999;';
        btn.addEventListener('click', async () => {
          btn.remove();
          const pw = await documentPictureInPicture.requestWindow({width: 300, height: 200});
          window._pipWin3 = pw;
          const pa = pw.document.createElement('audio');
          pa.src = '/tone.wav?preenter';
          pa.loop = true;
          pw.document.body.appendChild(pa);
          window._preEnterAudio = pa;
          await pa.play();
          window._pip3Ready = true;
        }, {once: true});
        document.body.appendChild(btn);
        return true;
      })()`
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      await waitFor(
        () => evalInSession(cdp, tab3.sessionId, `window._pip3Ready === true`),
        5000
      );
      await sleep(600);
      const opener10fState = await evalInSession(
        cdp,
        tab3.sessionId,
        `({
        opener: {paused: _opener10f.paused, rate: _opener10f.playbackRate, vol: _opener10f.volume},
        preEnter: {paused: _preEnterAudio.paused, rate: _preEnterAudio.playbackRate, vol: _preEnterAudio.volume}
      })`
      );
      const sw10f = await evalInSession(
        cdp,
        swSid,
        `({activeTab: state.activeTab, mediaPlaying: state.mediaPlaying, pipTabs: state.pipTabs})`
      );
      assert.equal(
        opener10fState.opener.paused,
        false,
        `pauseoninactive+disableresume paused opener on PiP open! ${JSON.stringify({opener10fState, sw10f})}`
      );
      assert.equal(
        opener10fState.opener.rate,
        1,
        `pauseoninactive+disableresume rate-zeroed opener on PiP open! ${JSON.stringify({opener10fState, sw10f})}`
      );
      assert.equal(
        opener10fState.preEnter.rate,
        1,
        `pre-enter pipWin audio self-paused! ${JSON.stringify({opener10fState, sw10f})}`
      );
      assert.equal(
        sw10f.activeTab,
        tab3Id,
        `activeTab corrupted on PiP open: ${JSON.stringify(sw10f)}`
      );
      await evalInSession(
        cdp,
        swSid,
        `delete options.pauseoninactive; delete options.disableresume; true`
      );

      // (b) Play Tab 2 -> BOTH opener audio AND pre-enter pipWin audio must auto-pause (proves checkDOM in attachDocPiP caught pre-enter audio!)
      // Also test muteonpause mutes BOTH openerTab and pipTab!
      const pipId10f = Number(Object.keys(sw10f.pipTabs)[0]);
      await evalInSession(cdp, swSid, `options.muteonpause = true; true`);
      await cdp.send('Target.activateTarget', {targetId: tab2.targetId});
      await sleep(200);
      await evalInSession(cdp, tab2.sessionId, `window.playShadow()`);
      const pausedPreEnter = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab3.sessionId,
          `({opRate: _opener10f.playbackRate, preRate: _preEnterAudio.playbackRate, preVol: _preEnterAudio.volume})`
        );
        return s.opRate === 0 && s.preRate === 0 && s.preVol === 0 ? s : null;
      }, 6000);
      const mutedBoth = await waitFor(async () => {
        const r = await evalInSession(
          cdp,
          swSid,
          `(async () => ({opMuted: (await chrome.tabs.get(${tab3Id})).mutedInfo?.muted, pipMuted: (await chrome.tabs.get(${pipId10f})).mutedInfo?.muted}))()`
        );
        return r.opMuted === true && r.pipMuted === true ? r : null;
      }, 5000);
      await evalInSession(
        cdp,
        swSid,
        `delete options.muteonpause; setTabMuted(${tab3Id}, false); true`
      );
      console.log(
        '10f(a-b). pauseoninactive+disableresume PiP open, pre-enter audio tracking, and muteonpause on both openerTab+pipTab passed:',
        {opener10fState, pausedPreEnter, mutedBoth}
      );

      // (c) Symmetric audible:false in tabs.onUpdated:
      // Make BOTH openerTab and pipTab audible (with Tab 2 paused), then pause ONLY opener audio -> Tab 2 must STAY paused!
      await cdp.send('Target.activateTarget', {targetId: tab3.targetId});
      await sleep(400);
      await waitFor(async () => {
        const r = await evalInSession(
          cdp,
          swSid,
          `(async () => ({opAud: (await chrome.tabs.get(${tab3Id})).audible, pipAud: (await chrome.tabs.get(${pipId10f})).audible, mp: state.mediaPlaying}))()`
        );
        return r.opAud && r.pipAud && r.mp === tab3Id ? r : null;
      }, 6000);
      await evalInSession(cdp, tab3.sessionId, `_opener10f.pause(); true`);
      await waitFor(
        () =>
          evalInSession(
            cdp,
            swSid,
            `chrome.tabs.get(${tab3Id}).then(t => t.audible === false)`
          ),
        8000
      );
      await sleep(400);
      const tab2AfterOpenerPause = await evalInSession(
        cdp,
        tab2.sessionId,
        `window.getShadowState()`
      );
      const mpAfterOpenerPause = await evalInSession(
        cdp,
        swSid,
        `state.mediaPlaying`
      );
      assert.equal(
        tab2AfterOpenerPause.playbackRate,
        0,
        `Tab 2 falsely resumed when opener went silent while pipTab stayed audible! ${JSON.stringify({tab2AfterOpenerPause, mpAfterOpenerPause})}`
      );
      assert.equal(
        mpAfterOpenerPause,
        tab3Id,
        `mediaPlaying changed while pipTab still audible: ${mpAfterOpenerPause}`
      );
      console.log(
        '10f(c). Symmetric audible:false kept Tab 2 paused while pipTab stayed audible:',
        {tab2AfterOpenerPause, mpAfterOpenerPause}
      );

      // (d) isGroupAudible on opener 'play': pipTab.audible=true, openerTab.audible=false -> activate Tab 2 then quickly switch back to Tab 3 while pipTab.audible is STILL true -> Tab 2 MUST be paused!
      await cdp.send('Target.activateTarget', {targetId: tab2.targetId});
      await sleep(350);
      const pipStillAudibleMid = await evalInSession(
        cdp,
        swSid,
        `chrome.tabs.get(${pipId10f}).then(t => t.audible)`
      );
      assert.equal(
        pipStillAudibleMid,
        true,
        'Expected pipTab.audible still true during quick switch test'
      );
      await cdp.send('Target.activateTarget', {targetId: tab3.targetId});
      const tab2PausedQuick = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab2.sessionId,
          `window.getShadowState()`
        );
        return s.playbackRate === 0 && s.volume === 0 ? s : null;
      }, 5000);
      console.log(
        '10f(d). Quick switch back while pipTab.audible=true & openerTab.audible=false properly paused Tab 2:',
        tab2PausedQuick
      );

      // (e) Document-pinned invalidation + otherTabs cleanup on PiP close!
      const docPinTest = await evalInSession(
        cdp,
        swSid,
        `(() => {
        const orig = {...state.pipTabs[${pipId10f}]};
        // Simulate a frameId=0 message from a NEW documentId in openerTab -> must invalidate stale link!
        invalidateMismatchedDocPiPLinks({tab: {id: ${tab3Id}}, frameId: 0, documentId: 'NEW_NAVIGATED_DOC'});
        const deletedOnMismatch = !hasProperty(state.pipTabs, ${pipId10f});
        // Restore original entry and test otherTabs cleanup on PiP close
        state.pipTabs[${pipId10f}] = orig;
        state.media.delete(${tab3Id});
        state.otherTabs.add(${tab3Id});
        return {orig, deletedOnMismatch};
      })()`
      );
      assert.equal(typeof docPinTest.orig.openerDocumentId, 'string');
      assert.equal(typeof docPinTest.orig.pipDocumentId, 'string');
      assert.equal(
        docPinTest.deletedOnMismatch,
        true,
        'Mismatched openerDocumentId must invalidate pipTabs link immediately'
      );
      await evalInSession(
        cdp,
        tab3.sessionId,
        `_preEnterAudio.pause(); _pipWin3.close(); true`
      );
      const otherTabsCleaned = await waitFor(async () => {
        const r = await evalInSession(
          cdp,
          swSid,
          `({otherHasTab3: state.otherTabs.has(${tab3Id}), pipCount: Object.keys(state.pipTabs).length})`
        );
        return !r.otherHasTab3 && r.pipCount === 0 ? r : null;
      }, 5000);
      console.log(
        '10f(e). Document-pinned invalidation & otherTabs cleanup on PiP close passed:',
        {deletedOnMismatch: docPinTest.deletedOnMismatch, otherTabsCleaned}
      );

      // Clean up Tab 2 shadow audio
      await evalInSession(cdp, tab2.sessionId, `window.pauseShadow()`);
      await sleep(300);

      // 10g. Rapid <200ms pause()->play() while auto-paused (denied background, allowed active, sibling isolation, source-swap NaN duration)
      await cdp.send('Target.activateTarget', {targetId: tab3.targetId});
      await sleep(200);
      await evalInSession(
        cdp,
        tab3.sessionId,
        `(async () => {
        const a = document.createElement('audio');
        a.src = '/tone.wav?rapidA';
        a.loop = true;
        const b = document.createElement('audio');
        b.src = '/tone.wav?rapidB';
        b.loop = true;
        document.body.append(a, b);
        window._rapidA = a;
        window._rapidB = b;
        await a.play();
        await b.play();
      })()`
      );
      await waitFor(
        () => evalInSession(cdp, swSid, `state.mediaPlaying === ${tab3Id}`),
        5000
      );
      // Switch to Tab 2 and play -> auto-pauses BOTH _rapidA and _rapidB on Tab 3
      await cdp.send('Target.activateTarget', {targetId: tab2.targetId});
      await sleep(200);
      await evalInSession(cdp, tab2.sessionId, `window.playShadow()`);
      await waitFor(
        () =>
          evalInSession(
            cdp,
            tab3.sessionId,
            `_rapidA.playbackRate === 0 && _rapidB.playbackRate === 0`
          ),
        5000
      );
      // (a) Denied background tab rapid pause()->play() (<200ms, NO user activation) must STAY at 0!
      await evalInSession(
        cdp,
        tab3.sessionId,
        `(async () => { _rapidA.pause(); await _rapidA.play(); })()`
      );
      await sleep(400);
      const rapidDenied = await evalInSession(
        cdp,
        tab3.sessionId,
        `({aRate: _rapidA.playbackRate, aVol: _rapidA.volume, bRate: _rapidB.playbackRate})`
      );
      assert.equal(
        rapidDenied.aRate,
        0,
        `Denied background rapid pause->play bypassed AutoPause! ${JSON.stringify(rapidDenied)}`
      );
      assert.equal(
        rapidDenied.aVol,
        0,
        `Denied background rapid pause->play restored volume! ${JSON.stringify(rapidDenied)}`
      );

      // (b) Allowed rapid pause()->play() (<200ms, WITH genuine user activation click) on _rapidB must restore ONLY _rapidB (NOT _rapidA, proving pause() cleared _rapidA's playRequested!)
      await evalInSession(cdp, swSid, `options.ignoretabchange = true; true`);
      await cdp.send('Target.activateTarget', {targetId: tab3.targetId});
      await sleep(200);
      await evalInSession(
        cdp,
        tab3.sessionId,
        `(() => {
        const btn = document.createElement('button');
        btn.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;z-index:999999;';
        btn.addEventListener('click', async () => {
          btn.remove();
          _rapidB.pause();
          await _rapidB.play();
        }, {once: true});
        document.body.appendChild(btn);
        return true;
      })()`
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      const rapidAllowed = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab3.sessionId,
          `({aRate: _rapidA.playbackRate, aVol: _rapidA.volume, bRate: _rapidB.playbackRate, bVol: _rapidB.volume})`
        );
        return s.bRate === 1 && s.bVol === 1 ? s : null;
      }, 5000);
      assert.equal(
        rapidAllowed.aRate,
        0,
        `Sibling _rapidA was wrongly woken by _rapidB normalPlayback! ${JSON.stringify(rapidAllowed)}`
      );
      assert.equal(
        rapidAllowed.aVol,
        0,
        `Sibling _rapidA volume wrongly restored! ${JSON.stringify(rapidAllowed)}`
      );

      // (c) Source-swap rapid pause() -> src change (isNaN(duration)) -> play() while auto-paused!
      await evalInSession(cdp, swSid, `pause(${tab3Id}); true`);
      await waitFor(
        () => evalInSession(cdp, tab3.sessionId, `_rapidB.playbackRate === 0`),
        5000
      );
      await evalInSession(
        cdp,
        tab3.sessionId,
        `(() => {
        const btn = document.createElement('button');
        btn.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;z-index:999999;';
        btn.addEventListener('click', async () => {
          btn.remove();
          _rapidB.pause();
          _rapidB.src = '/tone.wav?swapped';
          await _rapidB.play();
        }, {once: true});
        document.body.appendChild(btn);
        return true;
      })()`
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      const rapidSwap = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab3.sessionId,
          `({bRate: _rapidB.playbackRate, bVol: _rapidB.volume})`
        );
        return s.bRate === 1 && s.bVol === 1 ? s : null;
      }, 5000);
      await evalInSession(cdp, swSid, `delete options.ignoretabchange; true`);
      await evalInSession(
        cdp,
        tab3.sessionId,
        `_rapidA.pause(); _rapidB.pause(); true`
      );
      await evalInSession(cdp, tab2.sessionId, `window.pauseShadow()`);
      await sleep(350);
      console.log(
        '10g. Rapid <200ms pause->play (denied, allowed + sibling isolation, source-swap NaN duration) verified:',
        {rapidDenied, rapidAllowed, rapidSwap}
      );

      // 10h. Muted (volume=0) video on hidden opener when Document PiP closes (empty DocPiP -> checkVisibility AND audible DocPiP -> playMuted) + standard leavepictureinpicture!
      await cdp.send('Target.activateTarget', {targetId: tab3.targetId});
      await sleep(200);
      await evalInSession(
        cdp,
        tab3.sessionId,
        `(async () => {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        const ctx = c.getContext('2d');
        const ac = new AudioContext();
        const osc = ac.createOscillator();
        const dest = ac.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        const stream = new MediaStream([...c.captureStream(15).getTracks(), ...dest.stream.getTracks()]);
        const rec = new MediaRecorder(stream);
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        const stopped = new Promise((r) => (rec.onstop = r));
        rec.start();
        for (let i = 0; i < 6; i++) {
          ctx.fillStyle = i % 2 ? '#0c9' : '#09f';
          ctx.fillRect(0, 0, 64, 64);
          await new Promise((r) => setTimeout(r, 40));
        }
        rec.stop();
        await stopped;
        ac.close();
        window._webmUrl = URL.createObjectURL(new Blob(chunks, {type: rec.mimeType || 'video/webm'}));
        const m = document.createElement('video');
        m.src = window._webmUrl;
        m.loop = true;
        m.muted = false;
        m.volume = 0;
        document.body.appendChild(m);
        window._hiddenMutedVid = m;
        await m.play();
        window._pip4Ready = false;
        const btn = document.createElement('button');
        btn.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;z-index:999999;';
        btn.addEventListener('click', async () => {
          btn.remove();
          const pw = await documentPictureInPicture.requestWindow({width: 260, height: 160});
          window._pipWin4 = pw;
          window._pip4Ready = true;
        }, {once: true});
        document.body.appendChild(btn);
      })()`
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      await waitFor(
        () => evalInSession(cdp, tab3.sessionId, `window._pip4Ready === true`),
        5000
      );
      await sleep(300);
      // Hide Tab 3 by activating Tab 2: volume=0 video in opener must keep playing while Document PiP is open
      await cdp.send('Target.activateTarget', {targetId: tab2.targetId});
      await sleep(350);
      const mutedWhilePipOpen = await evalInSession(
        cdp,
        tab3.sessionId,
        `({paused: _hiddenMutedVid.paused, rate: _hiddenMutedVid.playbackRate})`
      );
      assert.equal(mutedWhilePipOpen.paused, false);
      assert.equal(
        mutedWhilePipOpen.rate,
        1,
        'Muted video must stay playing while Document PiP is open'
      );
      // Close empty Document PiP while Tab 3 stays hidden -> attachDocPiP pagehide checkVisibility() must auto-pause it!
      await evalInSession(cdp, tab3.sessionId, `_pipWin4.close(); true`);
      const mutedPausedAfterEmptyPipClose = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab3.sessionId,
          `({paused: _hiddenMutedVid.paused, rate: _hiddenMutedVid.playbackRate})`
        );
        return !s.paused && s.rate === 0 ? s : null;
      }, 5000);

      // Now test the removed && !isPlaying() && Elements.size > 0 -> send('playMuted') path:
      // Re-activate Tab 3 (resumes video), open DocPiP with an AUDIBLE audio inside pipWin (moves tab3 into state.media), hide Tab 3, then close DocPiP -> hidden volume=0 video must still pause!
      await cdp.send('Target.activateTarget', {targetId: tab3.targetId});
      await waitFor(
        () =>
          evalInSession(
            cdp,
            tab3.sessionId,
            `_hiddenMutedVid.playbackRate === 1`
          ),
        5000
      );
      await evalInSession(
        cdp,
        tab3.sessionId,
        `(() => {
        window._pip5Ready = false;
        const btn = document.createElement('button');
        btn.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;z-index:999999;';
        btn.addEventListener('click', async () => {
          btn.remove();
          const pw = await documentPictureInPicture.requestWindow({width: 260, height: 160});
          const a = pw.document.createElement('audio');
          a.src = location.origin + '/tone.wav?pip5';
          a.loop = true;
          pw.document.body.appendChild(a);
          await a.play();
          window._pipWin5 = pw;
          window._pip5Ready = true;
        }, {once: true});
        document.body.appendChild(btn);
        return true;
      })()`
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      await waitFor(
        () => evalInSession(cdp, tab3.sessionId, `window._pip5Ready === true`),
        5000
      );
      await waitFor(
        () => evalInSession(cdp, swSid, `state.media.has(${tab3Id})`),
        5000
      );
      await cdp.send('Target.activateTarget', {targetId: tab2.targetId});
      await sleep(350);
      await evalInSession(cdp, tab3.sessionId, `_pipWin5.close(); true`);
      const mutedPausedAfterAudiblePipClose = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab3.sessionId,
          `({paused: _hiddenMutedVid.paused, rate: _hiddenMutedVid.playbackRate})`
        );
        return !s.paused && s.rate === 0 ? s : null;
      }, 5000);
      await evalInSession(cdp, tab3.sessionId, `_hiddenMutedVid.pause(); true`);
      await sleep(300);

      // Standard video Picture-in-Picture leavepictureinpicture while tab is hidden!
      await cdp.send('Target.activateTarget', {targetId: tab3.targetId});
      await sleep(200);
      await evalInSession(
        cdp,
        tab3.sessionId,
        `(async () => {
        const v = document.createElement('video');
        v.src = window._webmUrl;
        v.loop = true;
        v.muted = false;
        v.volume = 0;
        document.body.appendChild(v);
        window._pipVideo = v;
        await v.play();
        window._vpipReady = false;
        const btn = document.createElement('button');
        btn.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;z-index:999999;';
        btn.addEventListener('click', async () => {
          btn.remove();
          await v.requestPictureInPicture();
          window._vpipReady = true;
        }, {once: true});
        document.body.appendChild(btn);
      })()`
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      await cdp.send(
        'Input.dispatchMouseEvent',
        {type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1},
        tab3.sessionId
      );
      await waitFor(
        () => evalInSession(cdp, tab3.sessionId, `window._vpipReady === true`),
        5000
      );
      await sleep(250);
      // Hide Tab 3 while standard video PiP is active -> must stay playing
      await cdp.send('Target.activateTarget', {targetId: tab2.targetId});
      await sleep(350);
      const vpipWhileOpen = await evalInSession(
        cdp,
        tab3.sessionId,
        `({paused: _pipVideo.paused, rate: _pipVideo.playbackRate})`
      );
      assert.equal(vpipWhileOpen.paused, false);
      assert.equal(
        vpipWhileOpen.rate,
        1,
        'Muted video in standard video PiP must stay playing while tab is hidden'
      );
      // Exit standard video PiP while Tab 3 is still hidden -> leavepictureinpicture must trigger pause!
      await evalInSession(
        cdp,
        tab3.sessionId,
        `document.exitPictureInPicture()`
      );
      const vpipPausedAfterExit = await waitFor(async () => {
        const s = await evalInSession(
          cdp,
          tab3.sessionId,
          `({paused: _pipVideo.paused, rate: _pipVideo.playbackRate})`
        );
        return !s.paused && s.rate === 0 ? s : null;
      }, 5000);
      await evalInSession(cdp, tab3.sessionId, `_pipVideo.pause(); true`);
      console.log(
        '10h. Exiting Document PiP (empty->checkVisibility & audible->playMuted) & standard video PiP (leavepictureinpicture) while hidden paused muted video:',
        {
          mutedPausedAfterEmptyPipClose,
          mutedPausedAfterAudiblePipClose,
          vpipPausedAfterExit
        }
      );

      // Check ZERO runtime exceptions across SW and ALL tabs
      assert.equal(swErrors.length, 0, `SW errors: ${swErrors}`);
      assert.equal(tab1.errors.length, 0, `Tab 1 errors: ${tab1.errors}`);
      assert.equal(tab2.errors.length, 0, `Tab 2 errors: ${tab2.errors}`);
      assert.equal(tab3.errors.length, 0, `Tab 3 errors: ${tab3.errors}`);
      console.log('11. ZERO runtime exceptions across SW and all 3 live tabs!');
      console.log('\nALL LIVE CHROMIUM E2E SMOKE TESTS PASSED!');
    } finally {
      await browserB.stop();
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
    console.error('SMOKE TEST FAILED:', err);
    process.exit(1);
  });
