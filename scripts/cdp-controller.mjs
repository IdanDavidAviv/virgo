#!/usr/bin/env node
/**
 * cdp-controller.mjs
 * Agent-controlled Antigravity automation via Chrome DevTools Protocol (CDP).
 */

import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import http from 'http';

const DIRNAME = dirname(fileURLToPath(import.meta.url));
const CDP_URL = 'http://localhost:9222';
const DIAG_LOG = resolve(DIRNAME, '..', 'diagnostics.log');
const AGENT_LOG = resolve(DIRNAME, '..', 'diagnostics_agent.log');
const SHELL_LOCK = resolve(DIRNAME, '..', '.cdp_shell.lock');
const PKG_PATH = resolve(DIRNAME, '..', 'package.json');
const LAUNCH_PATH = resolve(DIRNAME, '..', '.vscode', 'launch.json');

const action = process.argv[2];

// ── Project Environment Configuration ──
function getProjectConfig() {
  try {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
    const launch = existsSync(LAUNCH_PATH) ? JSON.parse(readFileSync(LAUNCH_PATH, 'utf8').replace(/\/\/.*/g, '')) : { configurations: [] };
    
    return {
      name: pkg.name,
      displayName: pkg.displayName,
      envs: {
        dev: launch.configurations.find(c => c.name.includes('Dev'))?.name || 'Extension (Dev)',
        prod: launch.configurations.find(c => c.name.includes('Prod'))?.name || 'Extension (Prod)',
      },
      markers: {
        host: 'Extension Development Host',
        hostArg: 'extensionDevelopmentPath',
        workbench: pkg.name
      }
    };
  } catch (e) {
    return { 
      name: 'virgo', 
      envs: { dev: 'Extension (Dev)', prod: 'Extension (Prod)' },
      markers: {
        host: 'Extension Development Host',
        hostArg: 'extensionDevelopmentPath',
        workbench: 'virgo'
      }
    };
  }
}

const CONFIG = getProjectConfig();

// ── Log Sovereignty: In-Memory Forensic Buffer ──
let lastLogTime = Date.now();
let inMemoryLogs = [];
let aggregatorState = { lastLine: null, count: 0 };

const NOISE_FILTER = [
  /\[Component\]/i,
  /Subscription initial call/,
  /\[Reactive\]/i,
  /\[STORE\] State Updated/,
  /\[STORE-SYNC-COMPLETE\]/,
  /\[VOL_TRACE\]/,
  /\[RATE_TRACE\]/
];

function processLogLine(line) {
  if (!line || line.trim() === '') { return; }
  const text = line.trim();
  if (NOISE_FILTER.some(pattern => pattern.test(text))) { return; }

  let tier = 3;
  if (text.includes('ERROR') || text.includes('WARN') || text.includes('SUCCESS') || text.includes('FAIL')) { tier = 1; }
  else if (text.includes('BOOTING') || text.includes('PIVOT') || text.includes('SESSION') || text.includes('CMD_RECV')) { tier = 2; }

  if (aggregatorState.lastLine === text) {
    aggregatorState.count++;
    if (inMemoryLogs.length > 0) { inMemoryLogs[inMemoryLogs.length - 1] = `${text} (x${aggregatorState.count + 1})`; }
  } else {
    aggregatorState.lastLine = text;
    aggregatorState.count = 0;
    inMemoryLogs.push(text);
  }

  if (inMemoryLogs.length > 2000) { inMemoryLogs.shift(); }
  if (tier <= 2) { process.stdout.write(`\r[LOG] ${text}\x1B[K\n`); }
}

// ── CDP Core ──

export async function connectToCDP() {
  if (existsSync(SHELL_LOCK)) {
    const oldPid = parseInt(readFileSync(SHELL_LOCK, 'utf8').trim(), 10);
    if (!isNaN(oldPid) && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0); // Check if alive
        console.error('╔══════════════════════════════════════════════════════════════╗');
        console.error(`║  [CDP] ✗ Blocked: Persistent shell is active (PID: ${oldPid})   ║`);
        console.error('║  Use \"send_command_input\" to talk to the active shell.       ║');
        console.error('╚══════════════════════════════════════════════════════════════╝');
        process.exit(1);
      } catch (e) { unlinkSync(SHELL_LOCK); }
    }
  }

  // ── Pre-flight HTTP Probe ──
  // Before attempting the WebSocket upgrade, verify the CDP HTTP endpoint is
  // actually responding. This distinguishes "port open but not CDP" from a
  // real CDP host. Timeout: 3s.
  console.log(`[CDP] 🔍 Pre-flight probe → ${CDP_URL}/json/version ...`);
  const probeOk = await new Promise((resolve) => {
    const req = http.get(`${CDP_URL}/json/version`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const v = JSON.parse(data);
          console.log(`[CDP] ✅ Probe OK — Browser: ${v.Browser || '?'} | WS: ${v.webSocketDebuggerUrl || '?'}`);
          resolve(true);
        } catch (e) {
          console.error(`[CDP] ⚠ Probe connected but response is not JSON: ${data.substring(0, 200)}`);
          resolve(false);
        }
      });
    });
    req.setTimeout(3000, () => {
      req.destroy();
      console.error(`[CDP] ✗ Probe TIMEOUT — port 9222 is bound but not responding to HTTP (not a CDP host?).`);
      resolve(false);
    });
    req.on('error', (e) => {
      console.error(`[CDP] ✗ Probe ERROR — ${e.code}: ${e.message}`);
      resolve(false);
    });
  });

  if (!probeOk) {
    console.error('[CDP] ✗ Cannot proceed — pre-flight probe failed. Check that Antigravity was launched with --remote-debugging-port=9222 and the debug port is not blocked by another process.');
    process.exit(1);
  }

  // ── WebSocket Upgrade ──
  try {
    console.log(`[CDP] 🔌 Connecting via Playwright WebSocket...`);
    const browser = await chromium.connectOverCDP(CDP_URL);
    console.log(`[CDP] ✅ Connected — ${browser.contexts().length} context(s) active.`);
    return browser;
  } catch (e) {
    console.error(`[CDP] ✗ Playwright connectOverCDP FAILED`);
    console.error(`[CDP]   Error type : ${e.constructor?.name || 'unknown'}`);
    console.error(`[CDP]   Message    : ${e.message}`);
    if (e.stack) { console.error(`[CDP]   Stack      : ${e.stack.split('\n').slice(0,4).join(' | ')}`); }
    process.exit(1);
  }
}

const hookedPages = new WeakSet();
function attachForensicListeners(page) {
  if (hookedPages.has(page)) { return; }
  hookedPages.add(page);
  page.on('console', msg => processLogLine(msg.text()));
  page.on('requestfailed', req => processLogLine(`[REQ_FAIL] ${req.url()}: ${req.failure()?.errorText || 'unknown'}`));
}

export async function getAllPages(browser) {
  const results = [];
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      attachForensicListeners(page);
      const title = await page.title().catch(() => '');
      results.push({ page, title, url: page.url() });
    }
  }
  return results;
}

/**
 * [v2.5.0] Proxy for Out-of-Process IFrames (OOPIF)
 * Since Playwright filters these out of the standard Page/Frame list,
 * we use raw CDP sessions to evaluate code within them.
 */
export class TargetProxy {
  constructor(browser, targetId, url, frameIndex = null) {
    this.browser = browser;
    this.targetId = targetId;
    this._url = url;
    this.frameIndex = frameIndex;
  }
  url() { return this._url; }
  async evaluate(fn, arg) {
    const browserSession = await this.browser.newBrowserCDPSession();
    const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId: this.targetId, flatten: false });
    
    let expression = typeof fn === 'function' 
      ? `(${fn.toString()})(${JSON.stringify(arg)})`
      : fn;

    if (this.frameIndex !== null) {
      // [v2.5.0] OOPIF Content Frame Redirection
      // If we are targeting the inner engine, we proxy the evaluation through the top window.
      // Since VS Code webviews are same-origin between wrapper and content, window.frames[0].eval works.
      expression = `(function() {
        try {
          const target = window.frames[${this.frameIndex}];
          if (!target) return "ERR: FRAME_NOT_FOUND";
          return target.eval(${JSON.stringify(expression)});
        } catch (e) {
          return "ERR: " + e.message;
        }
      })()`;
    }

    const messageId = Math.floor(Math.random() * 1000000);
    const message = JSON.stringify({
      id: messageId,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true }
    });
    
    return new Promise(async (resolve, reject) => {
      const handler = (params) => {
        if (params.sessionId === sessionId) {
          try {
            const res = JSON.parse(params.message);
            if (res.id === messageId) {
              browserSession.off('Target.receivedMessageFromTarget', handler);
              if (res.error) {reject(new Error(res.error.message));}
              else if (res.result.exceptionDetails) {reject(new Error(res.result.exceptionDetails.exception.description));}
              else {resolve(res.result.result.value);}
            }
          } catch (e) { /* ignore parse errors for other messages */ }
        }
      };
      browserSession.on('Target.receivedMessageFromTarget', handler);
      await browserSession.send('Target.sendMessageToTarget', { sessionId, message });
    });
  }
}

export function getRawTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${CDP_URL}/json`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`getRawTargets: JSON parse failed — ${e.message}`)); }
      });
    });
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('getRawTargets: HTTP timeout after 5000ms'));
    });
    req.on('error', reject);
  });
}

export async function findSovereignTarget(browser, type, verbose = false, env = null) {
  const allPages = await getAllPages(browser);
  if (verbose) { console.log(`[CDP] Finding ${type} among ${allPages.length} pages...`); }

  if (type === 'host') {
    const p = allPages.find(p => p.url.includes(CONFIG.markers.hostArg) || p.title.includes(CONFIG.markers.host));
    if (verbose) { console.log(`[CDP] Host check: ${p?.title ?? 'NONE'}`); }
    return p?.page || null;
  }
  if (type === 'workbench') {
    const p = allPages.find(p => p.url.includes('workbench.html') && !p.url.includes(CONFIG.markers.hostArg) && !p.title.includes(CONFIG.markers.host));
    if (verbose) { console.log(`[CDP] Workbench check: ${p?.title ?? 'NONE'}`); }
    return p?.page || null;
  }
  if (type === 'webview' || type === 'engine' || type === 'dashboard') {
    const frames = [];
    for (const { page, title, url } of allPages) {
      const isDevHost = url.includes(CONFIG.markers.hostArg) || title.includes(CONFIG.markers.host);
      if (env === 'dev' && !isDevHost) {continue;}
      if (env === 'main' && isDevHost) {continue;}
      frames.push(...page.frames());
    }
    // Fast-path: check Playwright frames for a live, hydrated webview.
    for (const f of frames) {
      try {
        const hasDebug = await f.evaluate(() => typeof window.__debug !== 'undefined' && window.__debug.isHydrated === true).catch(() => false);
        if (hasDebug) { return f; }
        const childDebugIndex = await f.evaluate(() => {
          for (let i = 0; i < window.frames.length; i++) {
             try { if (typeof window.frames[i].__debug !== 'undefined' && window.frames[i].__debug.isHydrated === true) {return i;} } catch {}
          }
          return -1;
        }).catch(() => -1);
        if (childDebugIndex !== -1) {
           const children = f.childFrames();
           if (children[childDebugIndex]) { return children[childDebugIndex]; }
        }
      } catch { }
    }
    // URL fast-path for non-hydrated but visible frames.
    for (const f of frames) {
      try {
        const url = f.url();
        if (url.includes('speechEngine.html') || (url.startsWith('vscode-webview://') && !url.includes('fake.html'))) { return f; }
      } catch { }
    }

    // [v2.5.0] OOPIF Resolution — ALWAYS runs, even when not hydrated.
    // VS Code webviews are Out-of-Process IFrames not visible to Playwright's standard frame list.
    // We deterministically locate them via the raw CDP /json endpoint regardless of hydration state.
    try {
      const rawTargets = await getRawTargets();
      const hostTargets = rawTargets.filter(t => t.title.includes(CONFIG.markers.host));
      
      for (const ht of hostTargets) {
        const isDevHost = ht.url.includes(CONFIG.markers.hostArg) || ht.title.includes(CONFIG.markers.host);
        if (env === 'dev' && !isDevHost) {continue;}
        if (env === 'main' && isDevHost) {continue;}

        // [DETERMINISTIC] Find all webview iframes for this host.
        // Prefer speech-engine (webviewView) — that's where our bundle runs.
        // Fall back to any webview child target if the panel URL isn't available.
        const webviewTargets = rawTargets.filter(t => 
          (t.type === 'iframe' || t.type === 'webview') && 
          t.parentId === ht.id
        );
        
        // Priority 1: our specific sidebar panel (webviewView targets contain 'speech-engine' or 'readme')
        let webviewTarget = webviewTargets.find(t => t.url.includes('speech-engine') || t.url.includes('readme'));
        // Priority 2: any webviewView
        if (!webviewTarget) { webviewTarget = webviewTargets.find(t => t.url.includes('purpose=webviewView')); }
        // Priority 3: first available
        if (!webviewTarget) { webviewTarget = webviewTargets[0]; }
        
        if (webviewTarget) {
          if (verbose) { console.log(`[CDP] OOPIF resolved: ${webviewTarget.id} (${webviewTarget.url.substring(0, 80)})`); }
          
          // 'engine'/'webview' -> content frame (index 0, where app.js runs inside the iframe)
          // 'dashboard' -> wrapper frame (null, the VS Code host page)
          let frameIndex = null;
          if (type === 'engine' || type === 'webview') { frameIndex = 0; }
          
          return new TargetProxy(browser, webviewTarget.id, webviewTarget.url, frameIndex);
        }
      }
    } catch (e) {
      if (verbose) { console.warn(`[CDP] OOPIF resolution failed: ${e.message}`); }
    }
  }
  return null;
}

async function shellDispatch(browser, command, payload = {}, env = null, retries = 5) {
  let frame = null;
  for (let i = 0; i < retries; i++) {
    frame = await findSovereignTarget(browser, 'webview', false, env);
    if (frame) {break;}
    await new Promise(r => setTimeout(r, 1000));
  }
  
  if (!frame) { throw new Error('READ_ALOUD_WEBVIEW_NOT_FOUND'); }
  return await frame.evaluate(async ({ cmd, data }) => {
    if (!window.__debug?.dispatcher?.dispatch) { throw new Error('DISPATCHER_NOT_READY'); }
    return await window.__debug.dispatcher.dispatch(cmd, data);
  }, { cmd: command, data: payload });
}

// ── Shared Utilities ──

let browserInstance = null;
const getbrowser = async (force = false) => {
  if (!browserInstance || force) {
    try { if (browserInstance) {await browserInstance.close();} } catch { }
    browserInstance = await connectToCDP();
  }
  return browserInstance;
};

const shellWaitForReady = async (maxRetries = 15) => {
  console.log('[CDP] ⏳ Waiting for System Ready...');
  await shellExec('virgo.show-dashboard');
  for (let i = 0; i < maxRetries; i++) {
    const b = await getbrowser();
    const f = await findSovereignTarget(b, 'webview');
    if (f) {
      const isReady = await f.evaluate(() => !!window.__debug?.isHydrated).catch(() => false);
      if (isReady) {
        console.log('[CDP] ✅ SYSTEM READY');
        return true;
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('[CDP] ❌ Timeout waiting for ready.');
  return false;
};

const shellExec = async (cmd) => {
  if (!cmd) { return; }
  const b = await getbrowser();
  if (cmd.startsWith('virgo.') && !cmd.startsWith('>')) {
    try {
      await shellDispatch(b, cmd);
      console.log('[CDP] ✓ Atomic Dispatch Success');
      return;
    } catch (e) { console.warn(`[CDP] ⚠ Atomic fail: ${e.message}. Falling back...`); }
  }
  const host = await findSovereignTarget(b, 'host');
  if (!host) {
    console.log('[CDP] 🛑 SAFEGUARD: Extension Development Host not found.');
    return;
  }
  const page = host;
  const cleanCmd = cmd.startsWith('>') ? cmd.substring(1) : cmd;
  await page.bringToFront();
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 200));
  await page.keyboard.press('Control+Shift+P');
  await new Promise(r => setTimeout(r, 400));
  await page.keyboard.type(cleanCmd, { delay: 20 });
  await new Promise(r => setTimeout(r, 500));
  await page.keyboard.press('Enter');
  console.log('[CDP] ✓ UI Dispatch Success');
};

const shellPrime = async () => {
  const b = await getbrowser();
  const f = await findSovereignTarget(b, 'webview');
  if (f) {
    console.log('[CDP] ⚡ Executing Wake Ritual...');
    await f.evaluate(() => {
      const event = new MouseEvent('mousedown', { view: window, bubbles: true, cancelable: true });
      document.dispatchEvent(event);
    });
    return true;
  }
  return false;
};

// ── Process Management ──

function snapshotAntigravityPids() {
  try {
    const raw = execSync('powershell -NoProfile -Command "Get-Process -Name \'Antigravity\' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"', { encoding: 'utf8' }).trim();
    return new Set(raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number));
  } catch { return new Set(); }
}

async function gracefulClose(devHostPids, protectedPids = new Set(), browser = null) {
  console.log('[CDP] 🔻 Initiating graceful shutdown...');
  if (browser) {
    const host = await findSovereignTarget(browser, 'host');
    if (host) {
      await shellExec('workbench.action.closeWindow');
    }
  }
  await new Promise(r => setTimeout(r, 2000));
  for (const pid of devHostPids) {
    if (protectedPids.has(pid)) { continue; }
    try { execSync(`taskkill /T /PID ${pid}`, { stdio: 'ignore' }); } catch { }
  }
}

// ── Shell logic ──

async function runShell() {
  writeFileSync(SHELL_LOCK, process.pid.toString());
  const mainPids = snapshotAntigravityPids();
  let browser = await connectToCDP();

  // ── Exit Ritual: stop playback → close Dev Host → exit shell ──
  const cleanupAndExit = async () => {
    console.log('\n[SHELL] 🔻 Exit Ritual: stopping playback...');
    try {
      const ef = await findSovereignTarget(browser, 'webview');
      if (ef) { await ef.evaluate(() => document.getElementById('btn-stop')?.click()).catch(() => {}); }
      await new Promise(r => setTimeout(r, 500));
    } catch {}
    console.log('[SHELL] 🔻 Closing Dev Host...');
    try {
      const devPids = snapshotAntigravityPids();
      await gracefulClose(devPids, mainPids, browser);
    } catch {}
    if (browser) { await browser.close().catch(() => {}); }
    if (existsSync(SHELL_LOCK)) { unlinkSync(SHELL_LOCK); }
    console.log('[SHELL] ✅ Done.');
    process.exit(0);
  };

  process.on('SIGINT', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);

  // ── Smart Start: auto-launch Dev Host if not already open ──
  const bootHost = await findSovereignTarget(browser, 'host');
  if (bootHost) {
    console.log('[CDP] 🟢 Dev Host already open — connected.');
  } else {
    console.log('[CDP] 🚀 No Dev Host found — auto-launching...');
    const bootMain = await findSovereignTarget(browser, 'workbench');
    if (bootMain) {
      await bootMain.bringToFront();
      await bootMain.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 200));
      await bootMain.keyboard.press('Control+Shift+P');
      await new Promise(r => setTimeout(r, 400));
      await bootMain.keyboard.type('workbench.action.debug.start', { delay: 20 });
      await new Promise(r => setTimeout(r, 500));
      await bootMain.keyboard.press('Enter');
      await shellWaitForReady();
    } else {
      console.error('[CDP] ❌ Main Editor not found — cannot auto-launch. Open VS Code first.');
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\ncdp> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd.toLowerCase()) {
      case 'status': 
        const b = await getbrowser(true);
        const host = await findSovereignTarget(b, 'host', true);
        const wvMain = await findSovereignTarget(b, 'webview', false, 'main');
        const wvDev = await findSovereignTarget(b, 'engine', false, 'dev');
        const wvWrap = await findSovereignTarget(b, 'dashboard', false, 'dev');
        
        console.log(`[CDP] Host: ${host ? '✅' : '❌'} | Webview (MAIN): ${wvMain ? '✅' : '❌'} | Webview (DEV): ${wvDev ? '✅' : '❌'}`);
        
        if (wvDev && wvWrap) {
          const wrapperB = await wvWrap.evaluate(() => typeof window.__BOOTSTRAP_CONFIG__);
          const contentB = await wvDev.evaluate(() => typeof window.__BOOTSTRAP_CONFIG__);
          console.log(`[CDP] Bootstrap -> Wrapper: ${wrapperB === 'object' ? '✅' : '❌'} | Content: ${contentB === 'object' ? '✅' : '❌'}`);
          
          const isHydrated = await wvDev.evaluate(() => window.__debug?.isHydrated).catch(() => false);
          console.log(`[CDP] Hydration: ${isHydrated ? '✅' : '❌'}`);
        }
        if (host) {console.log(`[CDP] Active Host ID: ${host.id || 'N/A'}`);}
        break;
      case 'launch':
        const launchB = await getbrowser();
        const main = await findSovereignTarget(launchB, 'workbench');
        if (main) {
          console.log('[CDP] 🚀 Triggering Launch (F5) in Main Editor...');
          // [META] Direct injection into workbench to avoid Host-Sovereignty check
          const page = main;
          await page.bringToFront();
          await page.keyboard.press('Escape');
          await new Promise(r => setTimeout(r, 200));
          await page.keyboard.press('Control+Shift+P');
          await new Promise(r => setTimeout(r, 400));
          await page.keyboard.type('workbench.action.debug.start', { delay: 20 });
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.press('Enter');
        } else {
          console.error('[CDP] ❌ Main Editor not found. Cannot launch.');
        }
        break;
      case 'wait-for-ready': await shellWaitForReady(); break;
      case 'prime': await shellPrime(); break;
      case 'dispatch':
      case 'exec': await shellExec(arg); break;
      case 'eval':
        const evalB = await getbrowser();
        const f = await findSovereignTarget(evalB, 'webview');
        if (f) {
          const res = await f.evaluate(e => { try { return JSON.stringify(eval(e), null, 2); } catch (err) { return `ERR: ${err.message}`; } }, arg);
          console.log(`[EVAL] Result:\n${res}`);
        }
        break;
      case 'stress':
        const stressB = await getbrowser();
        const stressWV = await findSovereignTarget(stressB, 'webview');
        if (stressWV) {
          console.log('🚀 Starting 100-iteration monotonic stress test...');
          let failures = 0;
          for (let i = 1; i <= 100; i++) {
            process.stdout.write(`[Iteration ${i}/100] `);
            try {
              await stressWV.evaluate(async () => {
                const s = window.__debug.store.getUIState();
                // Prime on first iteration or if blocked
                if (window.__debug.playback.isStalled || s.playbackIntent !== 'PLAYING') {
                  const btn = document.getElementById('btn-play');
                  if (btn) {btn.click();}
                } else {
                  await window.__debug.playback.play();
                }
              });
              
              let success = false;
              for (let j = 0; j < 20; j++) { // Increased poll window to 2s
                const state = await stressWV.evaluate(() => {
                  const ui = window.__debug.store.getUIState();
                  return { intent: ui.playbackIntent };
                });
                if (state.intent === 'PLAYING') {
                  process.stdout.write(`✅\n`);
                  success = true;
                  break;
                }
                await new Promise(r => setTimeout(r, 100));
              }
              if (!success) {
                process.stdout.write(`❌\n`);
                failures++;
              }
            } catch (err) {
              process.stdout.write(`💥 (${err.message})\n`);
              failures++;
            }
            await new Promise(r => setTimeout(r, 200));
          }
          console.log(`\n--- Stress Test Summary ---`);
          console.log(`Total: 100 | Success: ${100 - failures} | Failures: ${failures}`);
        }
        break;
      // [SURGICAL] click-play: Fires the real btn-play DOM click inside the webview content frame.
      // Unlike `dispatch`, this triggers the browser's user-gesture gate (userHasInteracted=true).
      case 'click-play': {
        const cpB = await getbrowser();
        const cpF = await findSovereignTarget(cpB, 'webview');
        if (!cpF) { console.log('[CDP] ❌ Webview content frame not found.'); break; }
        const cpRes = await cpF.evaluate(() => {
          const btn = document.getElementById('btn-play');
          if (!btn) { return 'ERR: btn-play not found'; }
          btn.click();
          return `OK: btn-play clicked (userHasInteracted should now be true)`;
        });
        console.log(`[CDP] click-play → ${cpRes}`);
        break;
      }
      // [SURGICAL] audit: Dumps live __debug state from the webview content frame.
      // Shows userHasInteracted, playbackIntent, intentId, audio element state, cache size.
      case 'audit': {
        const auB = await getbrowser();
        const auF = await findSovereignTarget(auB, 'webview');
        if (!auF) { console.log('[CDP] ❌ Webview content frame not found.'); break; }
        const auRes = await auF.evaluate(() => {
          const d = window.__debug;
          const audio = document.querySelector('audio');
          return JSON.stringify({
            isHydrated: d?.isHydrated,
            userHasInteracted: d?.playback?._userHasInteracted,
            playbackIntent: d?.store?.getUIState?.()?.playbackIntent,
            intentId: d?.store?.getState?.()?.playbackIntentId,
            playbackAuthorized: d?.store?.getState?.()?.playbackAuthorized,
            cacheCount: d?.store?.getState?.()?.cacheCount,
            audio: audio ? {
              src: audio.src || '(empty)',
              readyState: audio.readyState,
              paused: audio.paused,
              duration: audio.duration,
              error: audio.error?.code ?? null
            } : 'NO_AUDIO_EL',
            btns: {
              play: !!document.getElementById('btn-play'),
              pause: !!document.getElementById('btn-pause'),
            }
          }, null, 2);
        });
        console.log(`[AUDIT]\n${auRes}`);
        break;
      }
      // [CLOSE-HOST] Gracefully closes the Dev Host window via Tier-1 (closeWindow)
      // then kills remaining Dev Host PIDs. Does NOT exit the shell script.
      case 'close-host': {
        console.log('[CDP] Closing Extension Development Host...');
        const chB = await getbrowser();
        const devPids = snapshotAntigravityPids();
        const mainPidsProtected = snapshotAntigravityPids(); // same snapshot = nothing killed that we shouldn't
        await gracefulClose(devPids, mainPids, chB);
        console.log('[CDP] ✅ Dev Host closed.');
        break;
      }
      // [RESTART] Smart cold-restart: close Dev Host only if open → F5 launch → wait-for-ready.
      // Guards against blind close when no Dev Host is running.
      case 'restart': {
        const rstB = await getbrowser();
        const existingHost = await findSovereignTarget(rstB, 'host');
        if (existingHost) {
          console.log('[CDP] 🔄 Restart: Dev Host found — closing...');
          const rstPids = snapshotAntigravityPids();
          await gracefulClose(rstPids, mainPids, rstB);
          console.log('[CDP] ⏳ Waiting for host to fully exit (2s)...');
          await new Promise(r => setTimeout(r, 2000));
        } else {
          console.log('[CDP] 🚀 Restart: No Dev Host open — launching fresh...');
        }
        const rstB2 = await getbrowser();
        const rstMain = await findSovereignTarget(rstB2, 'workbench');
        if (rstMain) {
          console.log('[CDP] 🚀 Launching Dev Host (F5)...');
          await rstMain.bringToFront();
          await rstMain.keyboard.press('Escape');
          await new Promise(r => setTimeout(r, 200));
          await rstMain.keyboard.press('Control+Shift+P');
          await new Promise(r => setTimeout(r, 400));
          await rstMain.keyboard.type('workbench.action.debug.start', { delay: 20 });
          await new Promise(r => setTimeout(r, 500));
          await rstMain.keyboard.press('Enter');
          console.log('[CDP] ⏳ Waiting for system ready...');
          await shellWaitForReady();
        } else {
          console.error('[CDP] ❌ Main Editor not found — cannot relaunch. Run `launch` manually.');
        }
        break;
      }
      case 'exit':
      case 'quit': await cleanupAndExit(); break;
      case 'help':
        console.log('\n  status         - Situation report\n  launch         - Trigger F5 (Debug)\n  close-host     - Gracefully close the Dev Host window + kill its PIDs\n  restart        - Smart restart: close-host (if open) → launch → wait-for-ready\n  wait-for-ready - Poll for hydration\n  prime          - Execute Wake Ritual\n  click-play     - DOM click btn-play (real gesture, sets userHasInteracted)\n  audit          - Dump __debug state from webview content frame\n  stress         - 100-iter monotonic stress test\n  dispatch       - VS Code command (Ctrl+Shift+P, NOT a gesture)\n  eval           - JS execution in content frame\n  exit           - Stop playback + close Dev Host + exit shell (full cleanup)\n');
        break;
    }
    rl.prompt();
  });
}

// ── Entry ──

(async () => {
  if (action === 'shell') { await runShell(); }
  else if (action === 'status') {
    const b = await connectToCDP();
    const host = await findSovereignTarget(b, 'host');
    const wvMain = await findSovereignTarget(b, 'webview', false, 'main');
    const wvDev = await findSovereignTarget(b, 'engine', false, 'dev');
    const wvWrap = await findSovereignTarget(b, 'dashboard', false, 'dev');
    
    console.log(`Host: ${host ? '✅' : '❌'} | Webview (MAIN): ${wvMain ? '✅' : '❌'} | Webview (DEV): ${wvDev ? '✅' : '❌'}`);
    
    if (wvDev && wvWrap) {
      const wrapperB = await wvWrap.evaluate(() => typeof window.__BOOTSTRAP_CONFIG__);
      const contentB = await wvDev.evaluate(() => typeof window.__BOOTSTRAP_CONFIG__);
      console.log(`Bootstrap -> Wrapper: ${wrapperB === 'object' ? '✅' : '❌'} | Content: ${contentB === 'object' ? '✅' : '❌'}`);
      
      const isHydrated = await wvDev.evaluate(() => window.__debug?.isHydrated).catch(() => false);
      console.log(`Hydration: ${isHydrated ? '✅' : '❌'}`);
    }
    await b.close();
  }
  else if (action === 'targets') {
    const b = await connectToCDP();
    const pages = await getAllPages(b);
    console.log('\n--- Active Pages ---');
    for (const p of pages) {
      // Find matching raw target to get ID
      const raw = await getRawTargets();
      const rt = raw.find(t => t.url === p.url);
      console.log(`- [${rt?.id || '?'}] ${p.title} (${p.url})`);
    }
    
    console.log('\n--- OOPIF Targets ---');
    try {
      const raw = await getRawTargets();
      for (const t of raw) {
        if (t.type === 'iframe') {
          console.log(`- [${t.id}] (Parent: ${t.parentId}) ${t.url.substring(0, 100)}...`);
        }
      }
    } catch (e) { console.error('Failed to fetch raw targets:', e.message); }
    await b.close();
  }
  else if (action === 'dispatch') {
    const cmd = process.argv.slice(3).join(' ');
    await shellExec(cmd);
    if (browserInstance) {await browserInstance.close();}
  }
  else if (action === 'eval') {
    const b = await connectToCDP();
    const env = process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : null;
    const f = await findSovereignTarget(b, 'webview', false, env);
    const expr = process.argv.slice(3).filter(a => a !== '--env' && a !== env).join(' ');
    if (f) {
      const res = await f.evaluate(e => { try { return JSON.stringify(eval(e)); } catch (err) { return `ERR: ${err.message}`; } }, expr);
      console.log(res);
    }
    await b.close();
  }
  else if (action === 'eval-host') {
    const b = await connectToCDP();
    const h = await findSovereignTarget(b, 'host');
    const expr = process.argv.slice(3).join(' ');
    if (h) {
      const res = await h.evaluate(e => { try { return JSON.stringify(eval(e)); } catch (err) { return `ERR: ${err.message}`; } }, expr);
      console.log(res);
    }
    await b.close();
  }
  else if (action === 'wait-for-ready') {
    await shellWaitForReady();
    if (browserInstance) {await browserInstance.close();}
  }
  else if (action === 'cleanup-all') {
    const b = await connectToCDP();
    await gracefulClose(snapshotAntigravityPids(), snapshotAntigravityPids(), b);
    await b.close();
  }
  else if (action === 'stress') {
    const b = await connectToCDP();
    const wv = await findSovereignTarget(b, 'webview');
    if (!wv) {
      console.error('❌ Webview target not found.');
      await b.close();
      return;
    }

    console.log('🚀 Starting 100-iteration monotonic stress test...');
    let failures = 0;
    for (let i = 1; i <= 100; i++) {
      process.stdout.write(`[Iteration ${i}/100] `);
      try {
        await wv.evaluate(async () => {
          const s = window.__debug.store.getUIState();
          if (window.__debug.playback.isStalled || s.playbackIntent !== 'PLAYING') {
            const btn = document.getElementById('btn-play');
            if (btn) {btn.click();}
          } else {
            await window.__debug.playback.play();
          }
        });
        
        let success = false;
        for (let j = 0; j < 20; j++) {
          const state = await wv.evaluate(() => {
            const ui = window.__debug.store.getUIState();
            return { intent: ui.playbackIntent, intentId: window.__debug.store.getState().playbackIntentId };
          });
          if (state.intent === 'PLAYING') {
            process.stdout.write(`✅ Intent: ${state.intentId}\n`);
            success = true;
            break;
          }
          await new Promise(r => setTimeout(r, 100));
        }
        if (!success) {
          process.stdout.write(`❌ FAILED\n`);
          failures++;
        }
      } catch (err) {
        process.stdout.write(`💥 (${err.message})\n`);
        failures++;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`\n--- Stress Test Summary ---`);
    console.log(`Total: 100 | Success: ${100 - failures} | Failures: ${failures}`);
    if (failures > 0) {
      console.error('❌ SOVEREIGNTY BREACHED: Stale state or silent failure detected.');
      process.exit(1);
    } else {
      console.log('✅ SOVEREIGNTY MAINTAINED: 100% atomic transitions.');
    }
    await b.close();
  }
  else if (action === 'test-buffering') {
    const b = await connectToCDP();
    const h = await findSovereignTarget(b, 'host', true);
    const wv = await findSovereignTarget(b, 'webview', true);
    
    if (!h || !wv) {
      console.error('❌ Missing targets for buffering test.');
      await b.close();
      return;
    }

    console.log('🧪 Starting Buffering Integrity Test...');
    
    // 1. Ensure visible
    await shellExec('virgo.speech-engine.focus');
    await new Promise(r => setTimeout(r, 1000));

    // 2. Start Playback
    console.log('▶ Triggering Play...');
    await shellExec('virgo.play');
    
    // 3. IMMEDIATELY Hide Sidebar
    console.log('🙈 Hiding Sidebar (Buffer Zone)...');
    await shellExec('workbench.action.closeSidebar');
    
    // 4. Wait for synthesis (3 seconds)
    console.log('⏳ Waiting for background synthesis...');
    await new Promise(r => setTimeout(r, 5000));
    
    // 5. Show Sidebar
    console.log('👀 Showing Sidebar (Flush Zone)...');
    await shellExec('virgo.speech-engine.focus');
    
    // 6. Verify state
    console.log('🔍 Auditing webview state...');
    await new Promise(r => setTimeout(r, 2000));
    const status = await wv.evaluate(() => {
      const state = window.__debug?.store?.getState();
      return { isPlaying: state?.isPlaying, intent: state?.playbackIntentId };
    });
    
    console.log(`Result: isPlaying=${status.isPlaying}, intentId=${status.intent}`);
    if (status.isPlaying) {
      console.log('✅ SUCCESS: Playback resumed after buffer flush.');
    } else {
      console.error('❌ FAILURE: Playback stuck or lost during hidden state.');
    }
    
    await b.close();
  }
  else if (action === 'playback-audit') {
    const iterations = parseInt(process.argv[3] || '5', 10);
    const b = await connectToCDP();

    // Ensure the Read Aloud panel is open and hydrated before starting.
    await shellWaitForReady();
    await new Promise(r => setTimeout(r, 500));

    const wv = await findSovereignTarget(b, 'webview');

    if (!wv) {
      console.error('\u274c Webview not found after wait-for-ready. Check panel visibility.');
      await b.close();
      return;
    }

    console.log(`\n\u{1F52C} Playback Audit \u2014 ${iterations} iteration(s)\n`);

    // ── Safe Stop: halt any in-progress playback without leaving audio running ──
    const stopPlayback = async () => {
      await wv.evaluate(() => {
        try {
          const state = window.__debug?.store?.getState?.();
          if (!state) { return; }
          if (state.isPlaying || state.isPaused) {
            // Prefer explicit pause button; fall back to play-toggle.
            const pauseBtn = document.getElementById('btn-pause');
            if (pauseBtn) { pauseBtn.click(); return; }
            const playBtn = document.getElementById('btn-play');
            if (playBtn) { playBtn.click(); }
          }
        } catch { }
      }).catch(() => {});
      // Drain the async stop pipeline before the next operation.
      await new Promise(r => setTimeout(r, 600));
    };

    // Ensure clean state before the first iteration.
    await stopPlayback();
    await new Promise(r => setTimeout(r, 400));

    // ── Pre-flight: verify a document is loaded and has content to play ──
    const preflight = await wv.evaluate(() => {
      const state = window.__debug?.store?.getState?.();
      // Use correct WebviewStore field names: currentSentences (not sentences), activeFileName (not activeDocument)
      return {
        sentences: state?.currentSentences?.length ?? state?.windowSentences?.length ?? 0,
        activeDoc: state?.activeFileName ?? state?.focusedFileName ?? null,
        cacheCount: state?.cacheCount ?? 0,
        isHydrated: window.__debug?.isHydrated ?? false,
      };
    }).catch(() => ({ sentences: 0, activeDoc: null, cacheCount: 0, isHydrated: false }));

    if (preflight.sentences === 0) {
      console.error('\n\u274c PRE-FLIGHT FAILED: No document loaded in the Read Aloud panel.');
      console.error('   \u2192 Open a Markdown file in VS Code and focus it so the extension loads content.');
      console.error(`   \u2192 Webview hydrated: ${preflight.isHydrated} | Active doc: ${preflight.activeDoc ?? 'none'}`);
      await b.close();
      return;
    }

    console.log(`   \u2713 Pre-flight OK: ${preflight.sentences} sentences loaded | doc: ${preflight.activeDoc ?? 'unknown'}\n`);

    const results = [];

    for (let i = 1; i <= iterations; i++) {
      process.stdout.write(`[Iter ${i}/${iterations}] `);
      // ── Settle: let any log writes from the previous iteration flush to disk ──
      await new Promise(r => setTimeout(r, 200));

      // ── Snapshot log file cursor so we only read NEW lines this iteration ──
      let logCursor = 0;
      try {
        if (existsSync(AGENT_LOG)) { logCursor = statSync(AGENT_LOG).size; }
      } catch { }

      // ── Trigger play directly in the webview context ──
      // WHY NOT shellExec('virgo.play'):
      //   That fires the VS Code command → extension host → IPC roundtrip.
      //   The webview's _userHasInteracted gate blocks PLAY_AUDIO delivery unless
      //   it was set by a real DOM click. shellPrime()'s mousedown on the frame
      //   does NOT satisfy PlaybackController._userHasInteracted.
      // WHY wv.evaluate:
      //   Runs inside the webview JS context. playback.play() sets _userHasInteracted = true
      //   and calls ensureAudioContext() before posting the IPC action — complete path.
      await wv.evaluate(() => {
        const playback = window.__debug?.playback;
        if (playback) {
          // Set the interaction gate manually (CDP is acting as the user gesture)
          playback._userHasInteracted = true;
          playback.play();
        }
      }).catch(() => {});

      // ── Poll for PLAYING state (max 8 s) ──
      // Check both isPlaying (audio element) and playbackIntent (store intent) —
      // there is a lag window where the store hasn't reflected the audio element state yet.
      let playing = false;
      for (let j = 0; j < 80; j++) {
        const state = await wv.evaluate(() => {
          const s = window.__debug?.store?.getState?.();
          return {
            isPlaying: s?.isPlaying ?? false,
            playbackIntent: s?.playbackIntent ?? 'STOPPED',
          };
        }).catch(() => ({ isPlaying: false, playbackIntent: 'STOPPED' }));
        if (state.isPlaying || state.playbackIntent === 'PLAYING') { playing = true; break; }
        await new Promise(r => setTimeout(r, 100));
      }

      if (!playing) {
        process.stdout.write(`\u26a0\ufe0f  Never reached PLAYING state\n`);
        results.push({ i, canplay: 0, mutexTimeouts: 0, pass: false, reason: 'NO_PLAY' });
        // Still stop defensively before next iteration.
        await stopPlayback();
        await new Promise(r => setTimeout(r, 400));
        continue;
      }

      // ── IMMEDIATELY stop — never leave audio running ——
      await stopPlayback();
      // Wait for the async logger to flush canplay events to disk.
      // Extension host logger is not synchronous — events land ~1s after the audio element fires.
      await new Promise(r => setTimeout(r, 1500));

      // ── Read log slice from cursor and extract diagnostics ──
      let canplayCount = 0;
      let mutexTimeouts = 0;
      let playingEvents = 0;
      try {
        if (existsSync(AGENT_LOG)) {
          const logData = readFileSync(AGENT_LOG);
          const slice = logData.slice(logCursor).toString('utf8');
          for (const line of slice.split('\n')) {
            // [DETECTOR FIX] The canplay log is emitted inside onCanPlay as:
            //   "[RATE_TRACE] 🎵 Neural canplay | playbackRate=..."
            // The old check looked for "[AUDIO] canplay" which never matched.
            // Now we match the actual pattern: RATE_TRACE + Neural canplay.
            if (line.includes('RATE_TRACE') && line.includes('Neural canplay')) { canplayCount++; }
            // Secondary signal: Sovereign PLAYING event — confirms audio element fired playing
            if (line.includes('Sovereign Event: PLAYING')) { playingEvents++; }
            if (line.includes('Mutex Safety Timeout')) { mutexTimeouts++; }
          }
        }
      } catch { }

      // Pass if: exactly 1 canplay AND at least 1 PLAYING sovereign event (no double-fire, no silence)
      const pass = canplayCount === 1 && playingEvents >= 1;
      const icon = pass ? '\u2705' : (canplayCount === 0 && playingEvents === 0) ? '\u2b55' : canplayCount > 1 ? '\u274c' : '\u26a0\ufe0f';
      const mutexNote = mutexTimeouts > 0 ? ` | mutex_timeout\u00d7${mutexTimeouts}` : '';
      const playNote = playingEvents > 0 ? ` | playing\u00d7${playingEvents}` : '';
      process.stdout.write(`${icon}  canplay\u00d7${canplayCount}${playNote}${mutexNote}\n`);
      results.push({ i, canplay: canplayCount, mutexTimeouts, pass });

      // Drain before next iteration.
      await new Promise(r => setTimeout(r, 800));
    }

    // ── Summary ──
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    console.log(`\n${'\u2500'.repeat(52)}`);
    console.log(`Playback Audit Complete | ${iterations} iterations`);
    console.log(`\u2705 PASS: ${passed}  \u274c FAIL: ${failed}`);
    if (failed === 0) {
      console.log('\n\u{1F3AF} CLEAN: Single canplay per sentence. Playback integrity confirmed.');
    } else {
      const noPlays = results.filter(r => r.reason === 'NO_PLAY').length;
      const dupes = results.filter(r => r.canplay > 1).length;
      if (noPlays > 0) { console.log(`   \u26a0\ufe0f  ${noPlays}\u00d7 NO_PLAY — engine never reached PLAYING state`); }
      if (dupes > 0)   { console.log(`   \u26a0\ufe0f  ${dupes}\u00d7 DUPLICATE canplay — audio element loaded twice`); }
      console.log('\nRe-run after your next fix to verify.');
      process.exit(1);
    }
    await b.close();
  }
  else {
    console.log('Usage: node scripts/cdp-controller.mjs [shell|status|targets|dispatch|eval|eval-host|wait-for-ready|cleanup-all|stress|test-buffering|playback-audit [N]]');
  }
})();
