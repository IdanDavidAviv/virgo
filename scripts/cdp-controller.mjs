#!/usr/bin/env node
/**
 * cdp-controller.mjs
 * Agent-controlled Antigravity automation via Chrome DevTools Protocol (CDP).
 *
 * Pre-requisite:
 *   Antigravity must be running with --remote-debugging-port=9222
 *   Permanent: argv.json + taskbar shortcut both patched — no manual step needed.
 *
 * Usage:
 *   node scripts/cdp-controller.mjs list-targets
 *   node scripts/cdp-controller.mjs launch-dev-host
 *   node scripts/cdp-controller.mjs wait-for-devhost
 *   node scripts/cdp-controller.mjs close-dev-host        ← polite (3-tier)
 *   node scripts/cdp-controller.mjs kill-dev-host         ← surgical PID kill (legacy)
 *   node scripts/cdp-controller.mjs observe-cycle         ← launch → signal → live tail → graceful close
 *   node scripts/cdp-controller.mjs eval-webview "<expr>" ← JS injection into live webview
 *   node scripts/cdp-controller.mjs shell                 ← INTERACTIVE: persistent REPL, one CDP connection
 *   node scripts/cdp-controller.mjs probe-cycle           ← legacy (kept for compat)
 *   node scripts/cdp-controller.mjs exec-command "<cmd>"
 */

import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CDP_URL    = 'http://localhost:9222';
const DIAG_LOG   = resolve(__dirname, '..', 'diagnostics.log');
const action     = process.argv[2];


// Parse optional flags: --duration <ms>, --eval <expr>
const flags = {};
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--duration' && process.argv[i + 1]) {
    flags.duration = parseInt(process.argv[++i], 10);
  } else if (process.argv[i] === '--eval' && process.argv[i + 1]) {
    flags.eval = process.argv[++i];
  }
}

// actionArg is only valid for actions that take a positional arg (eval-webview, exec-command)
// For observe-cycle with flags, process.argv[3] may be a flag like '--duration', so guard it.
const actionArg = (process.argv[3] && !process.argv[3].startsWith('--')) ? process.argv[3] : undefined;

// ─────────────────────────────────────────────────────────────
// CDP Connection
// ─────────────────────────────────────────────────────────────

async function connectToCDP() {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    return browser;
  } catch {
    console.error('[CDP] ✗ Cannot connect to', CDP_URL);
    console.error('[CDP]   Is Antigravity running with --remote-debugging-port=9222?');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// Target Discovery
// ─────────────────────────────────────────────────────────────

/** Collects all pages across all contexts with their titles. */
async function getAllPages(browser) {
  const results = [];
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      const title = await page.title().catch(() => '');
      results.push({ page, title, url: page.url() });
    }
  }
  return results;
}

/**
 * Finds the main Antigravity workbench shell.
 * LAW: The real workbench shell always loads workbench.html.
 *      Preview tabs, Launchpad, and agent panels use about:blank or other URLs.
 *      NEVER match on title alone — preview tabs also contain "Antigravity" in their title.
 */
async function findWorkbenchPage(browser) {
  const pages = await getAllPages(browser);
  for (const { page, title, url } of pages) {
    const isDevHost   = title.includes('Extension Development Host');
    const isWebview   = url.includes('vscode-webview');
    const isRealShell = url.includes('workbench.html');
    if (isRealShell && !isDevHost && !isWebview) { return page; }
  }
  return null;
}

/**
 * Finds the [Extension Development Host] page in CDP targets.
 * Identified by title, not URL — this is reliable.
 */
async function findDevHostPage(browser) {
  const pages = await getAllPages(browser);
  for (const { page, title } of pages) {
    if (title.includes('Extension Development Host')) { return page; }
  }
  return null;
}

/**
 * Finds the Read Aloud webview FRAME inside the dev host page.
 * VS Code webviews are sandboxed iframes within the workbench renderer process.
 * They do NOT appear as separate CDP top-level targets.
 *
 * VS Code uses a two-frame webview architecture:
 *   - index.html  → outer shell / service worker wrapper (no user content)
 *   - fake.html   → inner content frame (this is where our bootstrap code runs)
 *
 * Strategy:
 *  1. Get the dev host page.
 *  2. Find vscode-webview:// frames.
 *  3. Prefer the one with fake.html (inner content frame).
 *  4. Fallback: first non-main vscode-webview frame.
 *  5. Last resort: any frame that has __BOOTSTRAP_CONFIG__ defined.
 */
async function findWebviewFrame(browser) {
  const devHostPage = await findDevHostPage(browser);
  if (!devHostPage) { return null; }

  const frames = devHostPage.frames();
  const webviewFrames = frames.filter(f => f.url().startsWith('vscode-webview://'));

  // Pass 1: prefer fake.html — this is the actual webview content frame
  const fakeFrame = webviewFrames.find(f => f.url().includes('/fake.html'));
  if (fakeFrame) { return fakeFrame; }

  // Pass 2: any non-index vscode-webview frame
  const contentFrame = webviewFrames.find(f => !f.url().includes('/index.html'));
  if (contentFrame) { return contentFrame; }

  // Pass 3: any vscode-webview frame (index.html or whatever is there)
  if (webviewFrames.length > 0) { return webviewFrames[0]; }

  // Pass 4: scan all non-main frames for __BOOTSTRAP_CONFIG__
  for (const frame of frames) {
    if (frame === devHostPage.mainFrame()) { continue; }
    try {
      const hasConfig = await frame.evaluate(() =>
        typeof (window).__BOOTSTRAP_CONFIG__ !== 'undefined'
      ).catch(() => false);
      if (hasConfig) { return frame; }
    } catch (_) { /* sandboxed frames may throw — skip */ }
  }

  return null;
}


/**
 * Snapshots all current Antigravity PIDs (no elevation required).
 */
function snapshotAntigravityPids() {
  try {
    const raw = execSync(
      "powershell -NoProfile -Command \"Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id\"",
      { encoding: 'utf8' }
    ).trim();
    return new Set(raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number));
  } catch {
    return new Set();
  }
}

/**
 * Polls until new Antigravity PIDs appear (delta from beforePids snapshot).
 */
async function waitForNewPids(beforePids, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = snapshotAntigravityPids();
    const newPids  = [...current].filter(pid => !beforePids.has(pid));
    if (newPids.length > 0) {return newPids;}
    await delay(1000);
  }
  throw new Error('[CDP] ✗ Timed out waiting for Extension Development Host PIDs.');
}

/**
 * After PIDs appear, poll diagnostics.log for the VOICE_SCAN SUCCESS signal —
 * the definitive "extension fully activated" marker.
 * Falls back to "ready" after timeoutMs even if signal never appears.
 */
async function waitForActivationSignal(timeoutMs = 15000) {
  console.log('[CDP] ⏳ Waiting for extension activation signal (VOICE_SCAN)...');
  const start = Date.now();
  let lastSize = 0;

  while (Date.now() - start < timeoutMs) {
    try {
      const content = readFileSync(DIAG_LOG, 'utf8');
      // Only scan lines written after we started waiting
      const newContent = content.slice(lastSize);
      lastSize = content.length;
      if (newContent.includes('[VOICE_SCAN] SUCCESS')) {
        console.log('[CDP] ✅ Activation signal received (VOICE_SCAN SUCCESS).');
        return true;
      }
      if (newContent.includes('[BOOT] extension_activated')) {
        console.log('[CDP] ✅ Activation signal received (BOOT extension_activated).');
        return true;
      }
    } catch { /* file may not exist yet */ }
    await delay(500);
  }
  console.log('[CDP] ⚠ Activation signal timeout — proceeding anyway (extension may still be loading).');
  return false;
}

// ─────────────────────────────────────────────────────────────
// Live Log Tail
// ─────────────────────────────────────────────────────────────

/**
 * Streams new lines from diagnostics.log to stdout in real time.
 * Returns a stop() function that ends the watcher.
 */
function startLiveLogTail() {
  console.log('[OBSERVE] 📡 Live tailing diagnostics.log...');
  let lastSize = 0;
  try { lastSize = readFileSync(DIAG_LOG, 'utf8').length; } catch {}

  const interval = setInterval(() => {
    try {
      const content = readFileSync(DIAG_LOG, 'utf8');
      if (content.length > lastSize) {
        const newLines = content.slice(lastSize).split('\n').filter(Boolean);
        for (const line of newLines) {
          console.log('[LOG]', line);
        }
        lastSize = content.length;
      }
    } catch {}
  }, 300);

  return () => clearInterval(interval);
}

// ─────────────────────────────────────────────────────────────
// Graceful Shutdown (3-Tier)
// ─────────────────────────────────────────────────────────────

/**
 * Tier 1: Send workbench.action.closeWindow via keyboard shortcut on the dev host page.
 * Returns true if the page was found and command was dispatched.
 */
async function politeCloseViaKeyboard(browser) {
  const devHostPage = await findDevHostPage(browser);
  if (!devHostPage) {
    console.log('[CDP] ⚠ Tier 1: Dev host CDP page not found — skipping keyboard close.');
    return false;
  }
  console.log('[CDP] 🤝 Tier 1: Sending workbench.action.closeWindow to dev host...');
  try {
    await devHostPage.bringToFront();
    await delay(200);
    await devHostPage.keyboard.press('Escape'); // dismiss any open modal
    await delay(150);
    await devHostPage.keyboard.press('Control+Shift+P');
    await delay(400);
    await devHostPage.keyboard.type('workbench.action.closeWindow', { delay: 20 });
    await delay(800);
    await devHostPage.keyboard.press('Enter');
    console.log('[CDP] ✓ Tier 1: Close command dispatched.');
    return true;
  } catch (err) {
    console.log('[CDP] ⚠ Tier 1: Keyboard close failed:', err.message);
    return false;
  }
}

/**
 * Tier 2: window.close() via Runtime.evaluate on the dev host page.
 */
async function politeCloseViaEval(browser) {
  const devHostPage = await findDevHostPage(browser);
  if (!devHostPage) {
    console.log('[CDP] ⚠ Tier 2: Dev host CDP page not found — skipping eval close.');
    return false;
  }
  console.log('[CDP] 🤝 Tier 2: Sending window.close() to dev host...');
  try {
    await devHostPage.evaluate(() => window.close());
    console.log('[CDP] ✓ Tier 2: window.close() dispatched.');
    return true;
  } catch (err) {
    console.log('[CDP] ⚠ Tier 2: Eval close failed:', err.message);
    return false;
  }
}

/**
 * Tier 3: Surgical PID kill — only the dev host PIDs, never the main editor.
 */
function surgicalPidKill(devHostPids) {
  if (!devHostPids || devHostPids.length === 0) {
    console.log('[CDP] No dev host PIDs to kill.');
    return;
  }
  console.log(`[CDP] 💀 Tier 3: Surgical PID kill (${devHostPids.length} process[es])...`);
  for (const pid of devHostPids) {
    try {
      execSync(
        `powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`,
        { encoding: 'utf8' }
      );
      console.log(`[CDP] ✓ Killed PID ${pid}`);
    } catch (err) {
      console.warn(`[CDP] ⚠ Could not kill PID ${pid}: ${err.message}`);
    }
  }
  console.log('[CDP] Dev host terminated.');
}

/**
 * Check if any of the given PIDs are still running.
 */
function arePidsAlive(pids) {
  const current = snapshotAntigravityPids();
  return pids.some(pid => current.has(pid));
}

/**
 * Main graceful shutdown: 3-tier ladder.
 * Tries polite → harder polite → surgical kill.
 */
async function gracefulClose(devHostPids) {
  console.log('[CDP] 🔻 Initiating graceful dev host shutdown...');

  const browser = await connectToCDP().catch(() => null);

  // Tier 1: Keyboard close
  if (browser) {
    await politeCloseViaKeyboard(browser);
    await delay(3000);
    if (!arePidsAlive(devHostPids)) {
      console.log('[CDP] ✅ Dev host closed cleanly (Tier 1).');
      await browser.close().catch(() => {});
      return;
    }

    // Tier 2: window.close() eval
    await politeCloseViaEval(browser);
    await delay(2000);
    if (!arePidsAlive(devHostPids)) {
      console.log('[CDP] ✅ Dev host closed cleanly (Tier 2).');
      await browser.close().catch(() => {});
      return;
    }

    await browser.close().catch(() => {});
  }

  // Tier 3: Surgical kill
  surgicalPidKill(devHostPids);
}

// ─────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────

/** list-targets — debug: print all CDP page targets */
async function listTargets() {
  const browser = await connectToCDP();
  const pages   = await getAllPages(browser);

  console.log(`[CDP] Connected to ${CDP_URL}`);
  console.log(`[CDP] Found ${pages.length} page target(s):\n`);
  for (const { title, url } of pages) {
    const tag = title.includes('Extension Development Host') ? '[DEV HOST] '
               : url.includes('workbench.html')              ? '[WORKBENCH]'
               : url.includes('vscode-webview')              ? '[WEBVIEW]  '
               : '[OTHER]    ';
    console.log(`  ${tag} "${title}"`);
    console.log(`             ${url}\n`);
  }
  await browser.close();
}

/** exec-command — trigger any VS Code command via the command palette */
async function execVSCodeCommand(commandName) {
  const browser = await connectToCDP();
  const page    = await findWorkbenchPage(browser);

  if (!page) {
    console.error('[CDP] ✗ Workbench shell not found (workbench.html).');
    console.error('[CDP]   Run list-targets to inspect available pages.');
    await browser.close();
    process.exit(1);
  }

  const pageTitle = await page.title().catch(() => '(unknown)');
  console.log(`[CDP] Target: "${pageTitle}"`);
  console.log(`[CDP] Executing: "${commandName}"`);

  await page.bringToFront();
  await page.keyboard.press('Escape');
  await delay(150);
  await page.keyboard.press('Control+Shift+P');
  await delay(350);
  await page.keyboard.type(commandName, { delay: 25 });
  await delay(1000);
  await page.keyboard.press('Enter');

  console.log('[CDP] ✓ Command dispatched.');
  await browser.close();
}

/** launch-dev-host — F5 equivalent */
async function launchDevHost() {
  console.log('[CDP] Triggering Extension Development Host (F5)...');
  const browser = await connectToCDP();
  const page    = await findWorkbenchPage(browser);

  if (!page) {
    console.error('[CDP] ✗ Workbench shell not found.');
    await browser.close();
    process.exit(1);
  }

  const pageTitle = await page.title().catch(() => '(unknown)');
  console.log(`[CDP] Target: "${pageTitle}"`);

  await page.bringToFront();
  await page.keyboard.press('Escape');
  await delay(150);

  // Step 1: Open command palette and run "Debug: Start Debugging"
  await page.keyboard.press('Control+Shift+P');
  await delay(350);
  await page.keyboard.type('Debug: Start Debugging', { delay: 25 });
  await delay(1000);
  await page.keyboard.press('Enter');
  console.log('[CDP] Step 1: "Debug: Start Debugging" dispatched.');

  // Step 2: Config picker — "Extension (Dev)" is already highlighted (Most Recent)
  await delay(600);
  await page.keyboard.press('Enter');
  console.log('[CDP] Step 2: Config picker confirmed (Extension Dev).');

  console.log('[CDP] ✓ Dev host launch dispatched.');
  await browser.close();
}

/** wait-for-devhost — blocks until new PIDs appear */
async function waitForDevHostAction() {
  console.log('[CDP] Waiting for Extension Development Host to appear...');
  const beforePids = snapshotAntigravityPids();
  const newPids = await waitForNewPids(beforePids, 30000);
  console.log(`[CDP] ✓ Dev host PIDs: ${newPids.join(', ')}`);
}

/** close-dev-host — polite 3-tier graceful shutdown */
async function closeDevHostAction() {
  console.log('[CDP] 🔻 close-dev-host: graceful shutdown requested...');
  // We don't know the PIDs here, collect them as "all non-main" processes
  const allPids   = snapshotAntigravityPids();
  const mainPid   = (() => {
    try {
      return parseInt(
        execSync("powershell -NoProfile -Command \"(Get-Process -Name 'Antigravity' | Where-Object { $_.MainWindowTitle -ne '' } | Sort-Object CPU -Descending | Select-Object -First 1).Id\"", { encoding: 'utf8' }).trim(),
        10
      );
    } catch { return null; }
  })();
  const devPids = [...allPids].filter(pid => pid !== mainPid);
  await gracefulClose(devPids);
}

/** kill-dev-host — legacy surgical kill (kept for backward compat) */
function killDevHostLegacy(devHostPids) {
  surgicalPidKill(devHostPids || []);
}

/** readDiagnosticsLog — prints the last N lines of diagnostics.log */
function readDiagnosticsLog(lines = 30) {
  console.log(`\n[CDP] ── diagnostics.log (last ${lines} lines) ────────────────────`);
  try {
    const content = readFileSync(DIAG_LOG, 'utf8');
    const tail    = content.trimEnd().split('\n').slice(-lines).join('\n');
    console.log(tail);
  } catch {
    console.error('[CDP] ✗ Could not read diagnostics.log — file missing or unreadable.');
  }
  console.log('[CDP] ────────────────────────────────────────────────────────────\n');
}

/**
 * eval-webview — evaluates a JS expression inside the Read Aloud webview.
 * Returns the result as JSON.
 */
async function evalWebview(expression) {
  if (!expression) {
    console.error('[CDP] ✗ eval-webview requires a JS expression argument.');
    process.exit(1);
  }
  const browser = await connectToCDP();
  const wv = await findWebviewFrame(browser);
  if (!wv) {
    console.error('[CDP] ✗ No webview page found (about:blank). Is the Read Aloud panel open?');
    await browser.close();
    process.exit(1);
  }

  const title = await wv.title().catch(() => '(untitled)');
  console.log(`[CDP] 🔬 Evaluating in webview: "${title}"`);
  console.log(`[CDP] Expression: ${expression}`);

  try {
    const result = await wv.evaluate(expr => {
      try { return JSON.stringify(eval(expr)); } catch (e) { return `ERROR: ${e.message}`; }
    }, expression);
    console.log(`[CDP] ✅ Result: ${result}`);
  } catch (err) {
    console.error(`[CDP] ✗ Eval failed: ${err.message}`);
  }
  await browser.close();
}

/**
 * observe-cycle — NEW primary agent loop.
 *
 * [1/5] Pre-launch PID snapshot
 * [2/5] Launch dev host (F5)
 * [3/5] Wait for PID delta + VOICE_SCAN activation signal
 * [4/5] OBSERVE WINDOW — live log tail (default 8s) + optional eval
 * [5/5] Graceful close (3-tier ladder)
 */
async function observeCycle() {
  const observeDurationMs = flags.duration ?? 8000;
  const evalExpr          = flags.eval ?? actionArg ?? null;

  console.log('[CDP] ══ OBSERVE CYCLE START ═════════════════════════════════════');
  console.log(`[CDP] Observe window: ${observeDurationMs}ms${evalExpr ? ` | eval: ${evalExpr}` : ''}`);

  // [1/5] Pre-launch snapshot
  const beforePids = snapshotAntigravityPids();
  console.log(`[CDP] Pre-launch snapshot: ${beforePids.size} Antigravity process(es).`);

  // [2/5] Launch
  console.log('[CDP] [2/5] Launching Extension Development Host...');
  await launchDevHost();

  // [3/5] Wait for PIDs + activation signal
  console.log('[CDP] [3/5] Waiting for dev host to boot...');
  const devHostPids = await waitForNewPids(beforePids, 30000);
  console.log(`[CDP] ✓ Dev host PIDs: ${devHostPids.join(', ')}`);
  await waitForActivationSignal(15000);

  // [4/5] Observe window — live log tail
  console.log(`[CDP] [4/5] OBSERVE WINDOW (${observeDurationMs}ms) — streaming live logs...`);
  console.log('[CDP] ───────────────────────────────────────────────────────────');
  const stopTail = startLiveLogTail();

  // Optional eval during observe window
  if (evalExpr) {
    await delay(2000); // let extension settle
    console.log(`[CDP] 🔬 Evaluating expression: ${evalExpr}`);
    try {
      const browser = await connectToCDP();
      const wv = await findWebviewFrame(browser);
      if (wv) {
        const result = await wv.evaluate(expr => {
          try { return JSON.stringify(eval(expr)); } catch (e) { return `ERROR: ${e.message}`; }
        }, evalExpr);
        console.log(`[CDP] 🔬 Eval result: ${result}`);
      } else {
        console.log('[CDP] ⚠ No webview target found for eval (panel may not be open yet).');
      }
      await browser.close();
    } catch (err) {
      console.log(`[CDP] ⚠ Eval error: ${err.message}`);
    }
  }

  await delay(observeDurationMs);
  stopTail();
  console.log('[CDP] ───────────────────────────────────────────────────────────');
  console.log('[CDP] Observe window closed.');

  // [5/5] Graceful close
  console.log('[CDP] [5/5] Initiating graceful shutdown...');
  await gracefulClose(devHostPids);

  // Final log snapshot
  readDiagnosticsLog(40);

  console.log('[CDP] ══ OBSERVE CYCLE COMPLETE ══════════════════════════════════');
}

/**
 * probe-cycle — legacy blind cycle (kept for backward compat).
 */
async function probeCycle() {
  console.log('[CDP] ══ PROBE CYCLE START ══════════════════════════════════════');

  const beforePids = snapshotAntigravityPids();
  console.log(`[CDP] Pre-launch snapshot: ${beforePids.size} Antigravity process(es).`);

  console.log('[CDP] [1/4] Launching Extension Development Host...');
  await launchDevHost();

  console.log('[CDP] [2/4] Waiting for dev host to boot (max 30s)...');
  const browser = await connectToCDP();
  let devHostPids;
  try {
    devHostPids = await waitForNewPids(beforePids, 30000);
    console.log(`[CDP] ✓ Dev host is live — new PID(s): ${devHostPids.join(', ')}`);
  } finally {
    await browser.close();
  }

  console.log('[CDP] [3/4] Waiting 3s for extension activation...');
  await delay(3000);

  console.log('[CDP] [4/4] Killing dev host...');
  surgicalPidKill(devHostPids);

  readDiagnosticsLog(30);

  console.log('[CDP] ══ PROBE CYCLE COMPLETE ════════════════════════════════════');
}

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
// Interactive Shell (REPL)
// ─────────────────────────────────────────────────────────────

/**
 * shell — Persistent interactive REPL.
 * Connects to CDP once, stays connected, accepts commands from stdin.
 * The dev host launch is optional — you can run it from inside the shell.
 *
 * Available commands:
 *   launch              — launch dev host (F5)
 *   close               — graceful 3-tier close
 *   kill                — surgical PID kill
 *   targets             — list all CDP pages
 *   eval <expr>         — evaluate JS expression in the Read Aloud webview
 *   exec <vs-cmd>       — execute a VS Code command via command palette
 *   log [n]             — print last n lines of diagnostics.log (default: 30)
 *   tail                — toggle live log tail on/off
 *   help                — print command list
 *   exit / quit         — close everything and exit
 */
async function runShell() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  CDP SHELL  —  Persistent debug session                       ║');
  console.log('║  Type "help" for commands.  Type "exit" to quit.               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Single persistent browser connection
  let browser = await connectToCDP();
  console.log(`[SHELL] ✅ Connected to ${CDP_URL}`);

  // Live tail state
  let tailInterval = null;
  let tailLastSize  = 0;

  const startTail = () => {
    if (tailInterval) return; // already running
    try { tailLastSize = readFileSync(DIAG_LOG, 'utf8').length; } catch { tailLastSize = 0; }
    tailInterval = setInterval(() => {
      try {
        const content = readFileSync(DIAG_LOG, 'utf8');
        if (content.length > tailLastSize) {
          const newLines = content.slice(tailLastSize).split('\n').filter(Boolean);
          for (const line of newLines) {console.log('[LOG]', line);}
          tailLastSize = content.length;
        }
      } catch {}
    }, 300);
    console.log('[SHELL] 📡 Log tail ON.');
  };

  const stopTail = () => {
    if (!tailInterval) return;
    clearInterval(tailInterval);
    tailInterval = null;
    console.log('[SHELL] Log tail OFF.');
  };

  /** Ensure browser is still connected; reconnect if not. */
  const getbrowser = async () => {
    try {
      // Ping: list contexts — throws if disconnected
      browser.contexts();
      return browser;
    } catch {
      console.log('[SHELL] ⚡ Reconnecting to CDP...');
      browser = await connectToCDP();
      console.log('[SHELL] ✅ Reconnected.');
      return browser;
    }
  };

  // Dev host PID tracking (set by 'launch' command)
  let devHostPids = [];

  // ── Shell command handlers ────────────────────────────────────

  const shellHelp = () => {
    console.log('');
    console.log('  launch              — launch dev host (F5)');
    console.log('  close               — graceful 3-tier shutdown of dev host');
    console.log('  kill                — surgical PID kill (last resort)');
    console.log('  targets             — list all CDP page targets');
    console.log('  eval <expr>         — evaluate JS in Read Aloud webview');
    console.log('  exec <vs-cmd>       — execute a VS Code command');
    console.log('  log [n]             — last n lines of diagnostics.log (default 30)');
    console.log('  tail                — toggle live log tail on/off');
    console.log('  exit | quit         — close shell');
    console.log('');
  };

  const shellTargets = async () => {
    const b = await getbrowser();
    const pages = await getAllPages(b);
    console.log(`\n[SHELL] ${pages.length} CDP page(s):`);
    for (const { title, url } of pages) {
      const tag = title.includes('Extension Development Host') ? '[DEV HOST]'
                 : url.includes('workbench.html')              ? '[WORKBENCH]'
                 : url.includes('vscode-webview')              ? '[WEBVIEW]  '
                 : '[OTHER]    ';
      console.log(`  ${tag}  "${title}"`);
      console.log(`             ${url}`);
    }
    console.log('');
  };

  const shellLaunch = async () => {
    const before = snapshotAntigravityPids();
    await launchDevHost();
    console.log('[SHELL] Waiting for dev host PIDs...');
    devHostPids = await waitForNewPids(before, 30000);
    console.log(`[SHELL] ✅ Dev host live — PIDs: ${devHostPids.join(', ')}`);
    await waitForActivationSignal(15000);
  };

  const shellClose = async () => {
    if (devHostPids.length === 0) {
      console.log('[SHELL] ⚠ No tracked dev host PIDs. Run "launch" first, or use "kill".');
      return;
    }
    await gracefulClose(devHostPids);
    devHostPids = [];
  };

  const shellKill = async () => {
    const allPids = [...snapshotAntigravityPids()];
    if (devHostPids.length > 0) {
      surgicalPidKill(devHostPids);
      devHostPids = [];
    } else {
      console.log('[SHELL] ⚠ No tracked PIDs. Killing all non-main Antigravity processes...');
      surgicalPidKill(allPids);
    }
  };

  const shellFrames = async () => {
    const b = await getbrowser();
    const devPage = await findDevHostPage(b);
    if (!devPage) {
      console.log('[SHELL] ⚠ No dev host page found. Launch first.');
      return;
    }
    const frames = devPage.frames();
    console.log(`[SHELL] 📦 ${frames.length} frame(s) in dev host:`);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const url = f.url();
      const isMain = f === devPage.mainFrame();
      console.log(`  [${i}] ${isMain ? '(main)' : '      '} ${url.substring(0, 100)}`);
    }
  };

  const shellEval = async (expr) => {
    if (!expr) { console.log('[SHELL] Usage: eval <JS expression>'); return; }
    const b     = await getbrowser();
    const frame = await findWebviewFrame(b);
    if (!frame) {
      console.log('[SHELL] ⚠ No Read Aloud webview frame found.');
      console.log('[SHELL]   Make sure the dev host is running and the Read Aloud panel is open.');
      console.log('[SHELL]   Try: exec readme-preview-read-aloud.show-dashboard');
      console.log('[SHELL]   Then run: frames   (to see all frames in the dev host)');
      return;
    }
    try {
      const result = await frame.evaluate((e) => {
        try { return JSON.stringify(eval(e), null, 2); } catch(err) { return `ERROR: ${err.message}`; }
      }, expr);
      console.log('[SHELL] 🔬 Result:');
      console.log(result);
    } catch (err) {
      console.log(`[SHELL] ✗ Eval failed: ${err.message}`);
    }
  };

  const shellExec = async (cmd) => {
    if (!cmd) { console.log('[SHELL] Usage: exec <vscode-command>'); return; }
    const b = await getbrowser();

    // When a dev host is live, prefer it as the command target.
    // Fall back to the main workbench if no dev host page is found.
    const devPage  = await findDevHostPage(b);
    const mainPage = devPage ? null : await findWorkbenchPage(b);
    const page     = devPage || mainPage;

    if (!page) {
      console.log('[SHELL] ✗ No workbench page found to dispatch command.');
      return;
    }

    const context = devPage ? '[DEV HOST]' : '[MAIN]';
    console.log(`[SHELL] ${context} exec: "${cmd}"`);

    await page.bringToFront();
    await page.keyboard.press('Escape');
    await delay(150);
    await page.keyboard.press('Control+Shift+P');
    await delay(350);
    await page.keyboard.type(cmd, { delay: 25 });
    await delay(1000);
    await page.keyboard.press('Enter');
    console.log('[SHELL] ✓ Command dispatched.');
  };

  const shellLog = (nStr) => {
    const n = parseInt(nStr, 10) || 30;
    readDiagnosticsLog(n);
  };

  const shellTail = () => {
    if (tailInterval) stopTail(); else startTail();
  };

  // ── readline loop ────────────────────────────────────────────

  const rl = createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: '\ncdp> ',
    terminal: true,
  });

  rl.prompt();

  rl.on('line', async (raw) => {
    const line  = raw.trim();
    const [cmd, ...rest] = line.split(/\s+/);
    const arg   = rest.join(' ');

    try {
      switch (cmd.toLowerCase()) {
        case '':        break;
        case 'help':    shellHelp();              break;
        case 'targets': await shellTargets();     break;
        case 'frames':  await shellFrames();      break;
        case 'launch':  await shellLaunch();      break;
        case 'close':   await shellClose();       break;
        case 'kill':    await shellKill();        break;
        case 'eval':    await shellEval(arg);     break;
        case 'exec':    await shellExec(arg);     break;
        case 'log':     shellLog(arg);            break;
        case 'tail':    shellTail();              break;
        case 'exit':
        case 'quit':
          console.log('[SHELL] Closing...');
          stopTail();
          await browser.close().catch(() => {});
          rl.close();
          process.exit(0);
          return;
        default:
          console.log(`[SHELL] Unknown command: "${cmd}". Type "help" for commands.`);
      }
    } catch (err) {
      console.log(`[SHELL] ✗ Error: ${err.message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    stopTail();
    browser.close().catch(() => {});
    process.exit(0);
  });
}

function printUsage() {
  console.error('[CDP] Usage: node scripts/cdp-controller.mjs <action> [arg] [--duration <ms>] [--eval <expr>]');
  console.error('[CDP] Actions:');
  console.error('[CDP]   shell                     — INTERACTIVE: persistent REPL shell (recommended)');
  console.error('[CDP]   list-targets              — show all CDP page targets');
  console.error('[CDP]   launch-dev-host           — trigger dev host (F5 equivalent)');
  console.error('[CDP]   wait-for-devhost          — block until dev host appears');
  console.error('[CDP]   close-dev-host            — graceful 3-tier shutdown (polite first)');
  console.error('[CDP]   kill-dev-host             — surgical PID kill (legacy)');
  console.error('[CDP]   observe-cycle             — launch → signal → live tail → graceful close');
  console.error('[CDP]   eval-webview "<expr>"     — evaluate JS in the live Read Aloud webview');
  console.error('[CDP]   probe-cycle               — legacy: launch → wait → kill → read log');
  console.error('[CDP]   exec-command "<name>"     — execute any command via command palette');
  console.error('[CDP] Flags:');
  console.error('[CDP]   --duration <ms>           — observe window duration (default: 8000)');
  console.error('[CDP]   --eval "<expr>"           — JS to eval in webview during observe window');
}

// ─────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────

if (!action) { printUsage(); process.exit(1); }

switch (action) {
  case 'shell':             runShell();                            break;
  case 'list-targets':      listTargets();                         break;
  case 'launch-dev-host':   launchDevHost();                       break;
  case 'wait-for-devhost':  waitForDevHostAction();                break;
  case 'close-dev-host':    closeDevHostAction();                  break;
  case 'kill-dev-host':     closeDevHostAction();                  break; // alias → graceful
  case 'observe-cycle':     observeCycle();                        break;
  case 'eval-webview':      evalWebview(actionArg);               break;
  case 'probe-cycle':       probeCycle();                          break;
  case 'exec-command':
    if (!actionArg) {
      console.error('[CDP] ✗ exec-command requires a command name argument.');
      process.exit(1);
    }
    execVSCodeCommand(actionArg);
    break;
  default:
    console.error(`[CDP] ✗ Unknown action: "${action}"`);
    printUsage();
    process.exit(1);
}
