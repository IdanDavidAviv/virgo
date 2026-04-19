#!/usr/bin/env node
/**
 * cdp-controller.mjs
 * Agent-controlled Antigravity automation via Chrome DevTools Protocol (CDP).
 *
 * Pre-requisite:
 *   Antigravity must be running with --remote-debugging-port=9222
 *
 * Usage:
 *   node scripts/cdp-controller.mjs shell                 ← INTERACTIVE: persistent REPL
 *   node scripts/cdp-controller.mjs status                ← Vital sign report
 *   node scripts/cdp-controller.mjs targets               ← List discovery targets
 *   node scripts/cdp-controller.mjs dispatch <cmd>        ← Atomic command execution
 *   node scripts/cdp-controller.mjs eval <expr>           ← JS execution in webview
 */

import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const DIRNAME = dirname(fileURLToPath(import.meta.url));
const CDP_URL = 'http://localhost:9222';
const DIAG_LOG = resolve(DIRNAME, '..', 'diagnostics.log');
const SHELL_LOCK = resolve(DIRNAME, '..', '.cdp_shell.lock');
const action = process.argv[2];

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

async function connectToCDP() {
  if (existsSync(SHELL_LOCK)) {
    const oldPid = parseInt(readFileSync(SHELL_LOCK, 'utf8').trim(), 10);
    if (!isNaN(oldPid) && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0); // Check if alive
        console.error('╔══════════════════════════════════════════════════════════════╗');
        console.error(`║  [CDP] ✗ Blocked: Persistent shell is active (PID: ${oldPid})   ║`);
        console.error('║  Use "send_command_input" to talk to the active shell.       ║');
        console.error('╚══════════════════════════════════════════════════════════════╝');
        process.exit(1);
      } catch (e) { unlinkSync(SHELL_LOCK); }
    }
  }
  try {
    return await chromium.connectOverCDP(CDP_URL);
  } catch {
    console.error('[CDP] ✗ Cannot connect. Is Antigravity running with --remote-debugging-port=9222?');
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

async function getAllPages(browser) {
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

async function findSovereignTarget(browser, type, verbose = false) {
  const allPages = await getAllPages(browser);
  if (type === 'workbench') {return allPages.find(p => p.url.includes('workbench.html') && !p.url.includes('extensionDevelopmentPath'))?.page || null;}
  if (type === 'host') {return allPages.find(p => p.url.includes('extensionDevelopmentPath') || p.title.includes('Extension Development Host'))?.page || null;}
  if (type === 'webview') {
    const frames = [];
    for (const { page } of allPages) {frames.push(...page.frames().filter(f => !f.isDetached()));}
    for (const f of frames) {
      try {
        if (await f.evaluate(() => typeof window.__debug !== 'undefined').catch(() => false)) {return f;}
      } catch { }
    }
    for (const f of frames) {
      try {
        if (await f.evaluate(() => typeof window.__BOOTSTRAP_CONFIG__ === 'object').catch(() => false)) {return f;}
      } catch { }
    }
    for (const f of frames) {if (f.url().startsWith('vscode-webview://') && f.url().includes('readme-preview-read-aloud')) {return f;}}
  }
  return null;
}

async function shellDispatch(browser, command, payload = {}) {
  const frame = await findSovereignTarget(browser, 'webview');
  if (!frame) {throw new Error('READ_ALOUD_WEBVIEW_NOT_FOUND');}
  return await frame.evaluate(async ({ cmd, data }) => {
    if (!window.__debug?.dispatcher?.dispatch) {throw new Error('DISPATCHER_NOT_READY');}
    return await window.__debug.dispatcher.dispatch(cmd, data);
  }, { cmd: command, data: payload });
}

// ── Process Management ──

function snapshotAntigravityPids() {
  try {
    const raw = execSync("powershell -NoProfile -Command \"Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id\"", { encoding: 'utf8' }).trim();
    return new Set(raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number));
  } catch { return new Set(); }
}

async function gracefulClose(devHostPids, protectedPids = new Set(), browser = null) {
  console.log('[CDP] 🔻 Initiating graceful shutdown...');
  if (browser) {
    const host = await findSovereignTarget(browser, 'host');
    if (host) {
      console.log('[CDP] Sending closeWindow to dev host...');
      await host.bringToFront();
      await host.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 200));
      await host.keyboard.press('Control+Shift+P');
      await new Promise(r => setTimeout(r, 400));
      await host.keyboard.type('workbench.action.closeWindow', { delay: 20 });
      await new Promise(r => setTimeout(r, 500));
      await host.keyboard.press('Enter');
    }
  }
  await new Promise(r => setTimeout(r, 2000));
  for (const pid of devHostPids) {
    if (protectedPids.has(pid)) {continue;}
    try { execSync(`taskkill /T /PID ${pid}`, { stdio: 'ignore' }); } catch { }
  }
}

// ── Shell logic ──

async function runShell() {
  writeFileSync(SHELL_LOCK, process.pid.toString());
  const mainPids = snapshotAntigravityPids();
  let browser = await connectToCDP();
  let tailInterval = null;
  let tailLastSize = 0;

  const cleanupAndExit = async () => {
    console.log('\n[SHELL] 🔻 Cleanup...');
    if (tailInterval) {clearInterval(tailInterval);}
    if (browser) {await browser.close().catch(() => { });}
    if (existsSync(SHELL_LOCK)) {unlinkSync(SHELL_LOCK);}
    process.exit(0);
  };

  process.on('SIGINT', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);

  const getbrowser = async (force = false) => {
    try {
      if (force) {throw new Error();}
      browser.contexts();
      return browser;
    } catch {
      try { await browser.close(); } catch { }
      browser = await connectToCDP();
      return browser;
    }
  };

  const shellStatus = async () => {
    const b = await getbrowser(true);
    const host = await findSovereignTarget(b, 'host');
    const workbench = await findSovereignTarget(b, 'workbench');
    const frame = await findSovereignTarget(b, 'webview');

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  SITUATION REPORT (v2.4.6 Hardening)                         ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`  Workbench:    ${workbench ? '✅ READY' : '❌ NOT FOUND'}`);
    console.log(`  Dev Host:     ${host ? '✅ LIVE' : '❌ LAUNCH REQ'}`);
    if (frame) {
      const vitals = await frame.evaluate(() => ({
        isHydrated: !!window.__debug?.store?.getState()?.activeDocumentUri,
        isPlaying: !!window.__debug?.store?.getState()?.isPlaying,
        file: window.__debug?.store?.getState()?.activeDocumentFileName || 'None'
      })).catch(() => ({ error: true }));
      console.log(`  Webview:      ✅ ${vitals.isHydrated ? 'HYDRATED' : 'WAITING'} | ${vitals.isPlaying ? '▶️ PLAYING' : '⏹️ STOPPED'}`);
      console.log(`  Document:     "${vitals.file}"`);
    } else { console.log(`  Webview:      ❌ NOT DETECTED`); }
    
    // Add PID scan to status
    const pids = Array.from(snapshotAntigravityPids());
    if (pids.length > 0) { console.log(`  Active PIDs:  [${pids.join(', ')}]`); }
    
    console.log('────────────────────────────────────────────────────────────────\n');
  };

  const shellWaitForReady = async (maxRetries = 10) => {
    console.log('[SHELL] ⏳ Waiting for System Ready...');
    await shellExec('readme-preview-read-aloud.show-dashboard');
    for (let i = 0; i < maxRetries; i++) {
      const b = await getbrowser();
      const f = await findSovereignTarget(b, 'webview');
      if (f) {
        const isReady = await f.evaluate(() => !!window.__debug?.store?.getState()?.activeDocumentUri).catch(() => false);
        if (isReady) {
          console.log('[SHELL] ✅ SYSTEM READY');
          return true;
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('[SHELL] ❌ Timeout waiting for ready.');
    return false;
  };

  const shellExec = async (cmd) => {
    if (!cmd) {return;}
    const b = await getbrowser();
    if (cmd.startsWith('readme-preview-read-aloud.') && !cmd.startsWith('>')) {
      try {
        await shellDispatch(b, cmd);
        console.log('[SHELL] ✓ Atomic Dispatch Success');
        return;
      } catch (e) { console.warn(`[SHELL] ⚠ Atomic fail: ${e.message}. Falling back...`); }
    }
    const host = await findSovereignTarget(b, 'host');
    const workbench = await findSovereignTarget(b, 'workbench');
    const page = host || workbench;
    if (!page) { console.log('[SHELL] ✗ No window found.'); return; }
    const cleanCmd = cmd.startsWith('>') ? cmd.substring(1) : cmd;
    await page.bringToFront();
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.press('Control+Shift+P');
    await new Promise(r => setTimeout(r, 400));
    await page.keyboard.type(`>${cleanCmd}`, { delay: 20 });
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.press('Enter');
    console.log('[SHELL] ✓ UI Dispatch Success');
  };

  const shellTargets = async () => {
    const b = await getbrowser();
    const pages = await getAllPages(b);
    console.log(`\n[SHELL] Found ${pages.length} target(s):`);
    for (const p of pages) {
      console.log(`  - "${p.title}" [${p.url.substring(0, 80)}...]`);
      const frames = p.page.frames();
      if (frames.length > 1) {
        console.log(`    └─ ${frames.length - 1} sub-frames:`);
        for (const f of frames) {
          if (f === p.page.mainFrame()) {continue;}
          console.log(`       - ${f.url().substring(0, 80)}...`);
        }
      }
    }
  };

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\ncdp> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd.toLowerCase()) {
      case 'status': await shellStatus(); break;
      case 'targets': await shellTargets(); break;
      case 'scan':
        const pids = Array.from(snapshotAntigravityPids());
        console.log(`[SHELL] Active Antigravity PIDs: ${pids.length ? pids.join(', ') : 'None'}`);
        break;
      case 'frames': await shellTargets(); break;
      case 'wait-for-ready': await shellWaitForReady(); break;
      case 'refresh':
        console.log('[SHELL] 🔄 Refreshing Window...');
        await shellExec('workbench.action.reloadWindow');
        await new Promise(r => setTimeout(r, 2000));
        await shellWaitForReady();
        break;
      case 'verify-state':
        const v_b = await getbrowser();
        const v_f = await findSovereignTarget(v_b, 'webview');
        if (v_f) {
          const state = await v_f.evaluate(() => JSON.stringify(window.__debug?.store?.getState(), null, 2)).catch(() => 'Error: Store not found');
          console.log(`[STATE]\n${state}`);
        } else { console.log('[STATE] ❌ No webview.'); }
        break;
      case 'cleanup-all':
        const hostPids = snapshotAntigravityPids();
        await gracefulClose(hostPids, mainPids, browser);
        break;
      case 'dispatch':
      case 'exec': await shellExec(arg); break;
      case 'eval':
        const b = await getbrowser();
        const f = await findSovereignTarget(b, 'webview');
        if (f) {
          const res = await f.evaluate(e => { try { return JSON.stringify(eval(e), null, 2); } catch (err) { return `ERR: ${err.message}`; } }, arg);
          console.log(`[EVAL] Result:\n${res}`);
        } else { console.log('[EVAL] ❌ No webview.'); }
        break;
      case 'launch':
        const wb = await findSovereignTarget(await getbrowser(), 'workbench');
        if (wb) {
          await wb.bringToFront();
          await wb.keyboard.press('Control+Shift+P');
          await new Promise(r => setTimeout(r, 400));
          await wb.keyboard.type('Debug: Start Debugging', { delay: 20 });
          await new Promise(r => setTimeout(r, 500));
          await wb.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 500));
          await wb.keyboard.press('Enter');
          console.log('[SHELL] ✓ Launch dispatched.');
        }
        break;
      case 'exit':
      case 'quit': await cleanupAndExit(); break;
      case 'help':
        console.log('\n  status         - Situation report\n  targets        - List discovery targets\n  scan           - Show active PIDs\n  wait-for-ready - Poll for hydration\n  refresh        - Reload window + Wait\n  verify-state   - Dump Redux store\n  dispatch       - VS Code command\n  eval           - JS execution\n  launch         - Start Debugging\n  cleanup-all    - Force close all hosts\n  exit           - Close shell\n');
        break;
      default: if (cmd) {console.log(`Unknown: ${cmd}`);} break;
    }
    rl.prompt();
  });
}

// ── Entry ──

const flags = {};
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--eval' && process.argv[i + 1]) {flags.eval = process.argv[++i];}
}

(async () => {
  if (action === 'shell') { await runShell(); }
  else if (action === 'status') {
    const b = await connectToCDP();
    const host = await findSovereignTarget(b, 'host');
    const wv = await findSovereignTarget(b, 'webview');
    console.log(`[CDP] Host: ${host ? '✅' : '❌'} | Webview: ${wv ? '✅' : '❌'}`);
    await b.close();
  }
  else if (action === 'targets') {
    const b = await connectToCDP();
    const pages = await getAllPages(b);
    pages.forEach(p => console.log(`- ${p.title} (${p.url.substring(0, 60)})`));
    await b.close();
  }
  else if (action === 'dispatch' || action === 'exec-command') {
    const b = await connectToCDP();
    const cmd = process.argv.slice(3).join(' ');
    if (cmd.startsWith('readme-preview-read-aloud.')) { await shellDispatch(b, cmd); }
    else {
      const p = await findSovereignTarget(b, 'workbench');
      if (p) {
        await p.bringToFront();
        await p.keyboard.press('Control+Shift+P');
        await new Promise(r => setTimeout(r, 400));
        await p.keyboard.type(cmd, { delay: 20 });
        await new Promise(r => setTimeout(r, 500));
        await p.keyboard.press('Enter');
      }
    }
    await b.close();
  }
  else if (action === 'eval') {
    const b = await connectToCDP();
    const f = await findSovereignTarget(b, 'webview');
    const expr = process.argv.slice(3).join(' ');
    if (f) {
      const res = await f.evaluate(e => { try { return JSON.stringify(eval(e)); } catch (err) { return `ERR: ${err.message}`; } }, expr);
      console.log(res);
    }
    await b.close();
  }
  else {
    console.log('Usage: node scripts/cdp-controller.mjs [shell|status|targets|dispatch|eval]');
  }
})();
