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
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const DIRNAME = dirname(fileURLToPath(import.meta.url));
const CDP_URL = 'http://localhost:9222';
const DIAG_LOG = resolve(DIRNAME, '..', 'diagnostics.log');
const SHELL_LOCK = resolve(DIRNAME, '..', '.cdp_shell.lock');
const action = process.argv[2];
let cachedWebviewFrame = null;

// ── Log Sovereignty: In-Memory Forensic Buffer ──
let inMemoryLogs = [];
let aggregatorState = { lastLine: null, count: 0 };

/** 
 * processLogLine — Smart Aggregator with Strict Noise Filtering
 * - Collapses repeated logs (xN)
 * - Assigns Tiers (1: Critical, 2: Ritual, 3: Noise)
 * - Filters Tier 3 (Noise) from INTERNAL BUFFERS and stdout
 */
const NOISE_FILTER = [
  /\[Component\]/i,
  /Subscription initial call/,
  /\[Reactive\]/i,
  /\[STORE\] State Updated/,
  /\[STORE-SYNC-COMPLETE\]/
];

function processLogLine(line) {
  if (!line || line.trim() === '') {return;}
  
  const text = line.trim();
  
  // Strict Noise Filtering: Discard Tier 3 before they touch memory or stdout
  if (NOISE_FILTER.some(pattern => pattern.test(text))) {
    return;
  }

  let tier = 3; 

  // Tier 1: Critical Signals
  if (text.includes('ERROR') || text.includes('WARN') || text.includes('SUCCESS') || text.includes('FAIL')) {
    tier = 1;
  }
  // Tier 2: Ritual/Flow Signals
  else if (text.includes('BOOTING') || text.includes('PIVOT') || text.includes('SESSION') || text.includes('CMD_RECV')) {
    tier = 2;
  }

  // Smart Aggregation (Collapse duplicates)
  if (aggregatorState.lastLine === text) {
    aggregatorState.count++;
    if (inMemoryLogs.length > 0) {
       inMemoryLogs[inMemoryLogs.length - 1] = `${text} (x${aggregatorState.count + 1})`;
    }
  } else {
    aggregatorState.lastLine = text;
    aggregatorState.count = 0;
    inMemoryLogs.push(text);
  }

  // Buffer Management (Keep 2000 entries for deep forensics)
  if (inMemoryLogs.length > 2000) {inMemoryLogs.shift();}

  // Real-time echo: Suppress Tier 3 (Noise) from terminal to keep UI clean
  if (tier <= 2) {
    process.stdout.write(`\r[LOG] ${text}\x1B[K\n`); // Clear line and write
  }
}


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

// WeakSet to track pages we already hooked to avoid duplicate event listeners
const hookedPages = new WeakSet();

function attachForensicListeners(page) {
  if (hookedPages.has(page)) {return;}
  hookedPages.add(page);

  page.on('console', msg => {
    const text = msg.text();
    processLogLine(text);
  });

  page.on('requestfailed', request => {
    processLogLine(`[REQ_FAIL] ${request.url()}: ${request.failure()?.errorText || 'unknown error'}`);
  });
}

/** Collects all pages across all contexts with their titles. */
async function getAllPages(browser) {
  const results = [];
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      attachForensicListeners(page); // Attach listeners during discovery pass
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
    const isWorkbench = url.includes('workbench.html');
    const isDevHost = url.includes('extensionDevelopmentPath') || title.includes('Extension Development Host');
    const isWebview = url.includes('vscode-webview');
    const hasAntigravity = title.includes('Antigravity');

    // [SOVEREIGNTY] Real workbench: workbench.html, NOT dev host, and usually has Antigravity title
    if (isWorkbench && !isDevHost && !isWebview && hasAntigravity) {
      return page;
    }
  }
  // Fallback: first workbench.html that isn't dev host
  for (const { page, title, url } of pages) {
    if (url.includes('workbench.html') && !(url.includes('extensionDevelopmentPath') || title.includes('Extension Development Host'))) {
      return page;
    }
  }
  return null;
}


/**
 * Finds all targets matching [Extension Development Host].
 */
async function findAllDevHosts(browser) {
  const allPages = await getAllPages(browser);
  return allPages.filter(p => p.url.includes('extensionDevelopmentPath') || p.title.includes('Extension Development Host'));
}

/**
 * Finds the FIRST [Extension Development Host] page in CDP targets.
 */
async function findDevHostPage(browser) {
  const hosts = await findAllDevHosts(browser);
  return hosts.length > 0 ? hosts[0].page : null;
}

/**
 * Finds the Read Aloud webview FRAME using a multi-layered discovery strategy.
 * VS Code webviews can reside in:
 *   1. A child frame of the main workbench page.
 *   2. A separate top-level page (if in certain panel/mode states).
 */
async function findWebviewFrame(browser, verbose = false, maxRetries = 3) {
  if (cachedWebviewFrame && !cachedWebviewFrame.isDetached()) {return cachedWebviewFrame;}

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const allPages = await getAllPages(browser);
    
    // [SOVEREIGNTY] Prioritize Dev Host targets in the discovery pass.
  // We want to avoid accidentally talking to the main editor's webview.
  allPages.sort((a, b) => {
    const isADev = a.url.includes('extensionDevelopmentPath') || a.title.includes('Extension Development Host');
    const isBDev = b.url.includes('extensionDevelopmentPath') || b.title.includes('Extension Development Host');
    if (isADev && !isBDev) {return -1;}
    if (!isADev && isBDev) {return 1;}
    return 0;
  });

  if (verbose) {console.log(`[CDP] 🔍 Scanning ${allPages.length} top-level targets for Read Aloud webview (Dev-First)...`);}

  // [v2.3.2] Multi-Pass Discovery with recursive frame scanning
  for (const { page, title } of allPages) {
    const frames = page.frames();
    if (verbose) {console.log(`  [Page] "${title}" (${frames.length} frames)`);}
    for (const f of frames) {
      if (f.isDetached()) {continue;}
      try {
        const url = f.url();
        if (verbose) {console.log(`    [Frame] ${url.substring(0, 80)}...`);}

        // [SOVEREIGNTY] Exclude system webviews (Media Preview, Markdown Preview, etc.)
        const isSystem = url.includes('extensionId=vscode.') || url.includes('extensionId=ms-vscode.');
        if (isSystem) {
          if (verbose) {console.log(`      ⏭ Skipping System Webview`);}
          continue;
        }

        // [SOVEREIGNTY] The debug store is the most authoritative marker
        const hasStore = await f.evaluate(() => typeof window.__debug?.store?.getState === 'function').catch(() => false);
        if (hasStore) {
          if (verbose) {console.log(`      🎯 MATCH! Pass 1 (Debug Store)`);}
          cachedWebviewFrame = f;
          return f;
        }

        // [SOVEREIGNTY] Fallback to bootstrap config
        const hasConfig = await f.evaluate(() => typeof window.__BOOTSTRAP_CONFIG__ === 'object').catch(() => false);
        if (hasConfig) {
          if (verbose) {console.log(`      🎯 MATCH! Pass 2 (Config Probe)`);}
          cachedWebviewFrame = f;
          return f;
        }

        // [SOVEREIGNTY] Final fallback: URL heuristic (ONLY for webviews)
        if (url.startsWith('vscode-webview://') && (title.includes('readme-preview-read-aloud') || url.includes('readme-preview-read-aloud'))) {
          if (verbose) {console.log(`      📍 MATCH! Pass 4 (URL Heuristic: "${url}")`);}
          cachedWebviewFrame = f;
          return f;
        }
      } catch (e) {
        if (verbose) {console.log(`    [Frame] ⚠ Probe error: ${e.message}`);}
      }
    }
  }

    if (attempt < maxRetries) {
      if (verbose) {console.log(`[CDP] ⏳ Discovery attempt ${attempt + 1} failed. Retrying in 800ms...`);}
      await new Promise(r => setTimeout(r, 800));
    }
  }

  if (verbose) {console.log('[CDP] ✗ No matching webview frame found across all targets.');}
  return null;
}

/** 
 * [v2.3.2] Sovereign RPC Bridge: Dispatch commands directly via Webview -> Extension RPC 
 * Bypasses the Command Palette (Ctrl+Shift+P) for high-integrity automation.
 */
async function shellExecDirect(browser, cmdId, args = []) {
  let frame = null;
  let attempts = 0;
  const maxAttempts = 5;

  // [v2.3.2] Bridge Hydration Retry Loop
  while (attempts < maxAttempts) {
    try {
      frame = await findWebviewFrame(browser);
      if (frame) {
        return await frame.evaluate(async ({ id, a }) => {
          if (!window.__SOVEREIGN_RPC__) {
            throw new Error('PENDING_HYDRATION');
          }
          return await window.__SOVEREIGN_RPC__(id, a);
        }, { id: cmdId, a: args });
      }
    } catch (err) {
      if (err.message.includes('PENDING_HYDRATION') || err.message.includes('Target page, context or browser has been closed')) {
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 600));
          continue;
        }
      }
      throw err;
    }
    attempts++;
    await new Promise(r => setTimeout(r, 600));
  }

  throw new Error('Webview frame or Sovereign Bridge not found after retries.');
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
    const newPids = [...current].filter(pid => !beforePids.has(pid));
    if (newPids.length > 0) { return newPids; }
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
  try { lastSize = readFileSync(DIAG_LOG, 'utf8').length; } catch { }

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
    } catch { }
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
    console.log('[CDP] ℹ️ Tier 1: Dev host transition found — already clean.');
    return true; 
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
    console.log('[CDP] ℹ️ Tier 2: Eval transition found — already clean.');
    return true;
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
function surgicalPidKill(devHostPids, protectedPids = new Set()) {
  if (!devHostPids || devHostPids.length === 0) {
    console.log('[CDP] No dev host PIDs to kill.');
    return;
  }

  const safeToKill = devHostPids.filter(pid => !protectedPids.has(pid));
  const blocked = devHostPids.filter(pid => protectedPids.has(pid));

  if (blocked.length > 0) {
    console.warn(`[CDP] 🛡️ PROTECTION BLOCKED kill of PIDs: ${blocked.join(', ')} (Protected/Main Host)`);
  }

  if (safeToKill.length === 0) {return;}

  console.log(`[CDP] 🤝 Tier 3: Requesting termination for ${safeToKill.length} process[es] (SIGTERM equivalent)...`);
  for (const pid of safeToKill) {
    try {
      // [v2.5.1] Use taskkill /T (request tree close) WITHOUT /F (force) for graceful OS-level exit
      execSync(`taskkill /T /PID ${pid}`, { stdio: 'ignore' });
      console.log(`[CDP] ✓ Signal sent to process tree for PID ${pid}`);
    } catch (err) {
      console.warn(`[CDP] ⚠ Could not terminate PID ${pid}: ${err.message}`);
    }
  }
  console.log('[CDP] Dev host termination requested.');
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
async function gracefulClose(devHostPids, protectedPids = new Set(), existingBrowser = null) {
  console.log('[CDP] 🔻 Initiating graceful dev host shutdown...');

  const browser = existingBrowser || await connectToCDP().catch(() => null);

  // Tier 1: Keyboard close
  if (browser) {
    await politeCloseViaKeyboard(browser);
    await delay(3000);
    if (!arePidsAlive(devHostPids)) {
      console.log('[CDP] ✅ Dev host closed cleanly (Tier 1).');
      if (!existingBrowser) {await browser.close().catch(() => { });}
      return;
    }

    // Tier 2: window.close() eval
    await politeCloseViaEval(browser);
    await delay(2000);
    if (!arePidsAlive(devHostPids)) {
      console.log('[CDP] ✅ Dev host closed cleanly (Tier 2).');
      if (!existingBrowser) {await browser.close().catch(() => { });}
      return;
    }
  }

  // Tier 3: Surgical PID kill
  surgicalPidKill(devHostPids, protectedPids);
  if (!existingBrowser && browser) {await browser.close().catch(() => { });}
}

// ─────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────

/** list-targets — debug: print all CDP page targets */
async function listTargets() {
  const browser = await connectToCDP();
  const pages = await getAllPages(browser);

  console.log(`[CDP] Connected to ${CDP_URL}`);
  console.log(`[CDP] Found ${pages.length} page target(s):\n`);
  for (const { title, url } of pages) {
    const tag = title.includes('Extension Development Host') ? '[DEV HOST] '
      : url.includes('workbench.html') ? '[WORKBENCH]'
        : url.includes('vscode-webview') ? '[WEBVIEW]  '
          : '[OTHER]    ';
    console.log(`  ${tag} "${title}"`);
    console.log(`             ${url}\n`);
  }
  await browser.close();
}

/** exec-command — trigger any VS Code command via the command palette */
async function execVSCodeCommand(commandName) {
  const browser = await connectToCDP();
  const page = await findWorkbenchPage(browser);

  if (!page) {
    console.error('[CDP] ✗ Workbench shell not found (workbench.html).');
    console.error('[CDP]   Run list-targets to inspect available pages.');
    await browser.close();
    process.exit(1);
  }

  // [v2.4.2] Sovereign Scoping: Project commands MUST ONLY target the Dev Host
  const isProjectCmd = commandName.startsWith('readme-preview-read-aloud.');
  if (isProjectCmd) {
    console.log(`[CDP] 🛡️ Project command detected. Enforcing Dev Host scoping...`);
    const devPage = await findDevHostPage(browser);
    if (!devPage) {
      console.error('[CDP] ✗ FAILED: Extension commands MUST be run on Dev Host.');
      console.error('[CDP]   The Main Editor context is protected.');
      await browser.close();
      process.exit(1);
    }
  }

  // [v2.3.2] Hybrid Sovereignty: Direct RPC vs. UI Simulation
  if (commandName.startsWith('readme-preview-read-aloud.')) {
    console.log(`[CDP] ⚡ Direct RPC detected...`);
    try {
      // Refresh browser context to ensure we have the Dev Host targets
      const devHostPage = await findDevHostPage(browser);
      const result = await shellExecDirect(browser, commandName);
      console.log(`[CDP] ✓ RPC Success${result ? ': ' + JSON.stringify(result) : ''}`);
      await browser.close();
      return;
    } catch (err) {
      console.warn(`[CDP] ⚠ RPC Bridge failed: ${err.message}. Falling back to UI simulation...`);
    }
  }

  // [v2.4.2] Final target resolution for UI simulation
  let targetPage = page;
  if (isProjectCmd) {
    targetPage = await findDevHostPage(browser);
  }

  if (!targetPage) {
    console.error('[CDP] ✗ No valid target page for command execution.');
    await browser.close();
    process.exit(1);
  }

  const pageTitle = await targetPage.title().catch(() => '(unknown)');
  console.log(`[CDP] Target: "${pageTitle}"`);
  console.log(`[CDP] Executing: "${commandName}"`);

  // [v2.4.0] Strip redundant '>' prefix if the agent/user provided it
  const sanitizedCmd = commandName.startsWith('>') ? commandName.substring(1) : commandName;

  await page.bringToFront();
  await page.keyboard.press('Escape');
  await delay(150);
  await page.keyboard.press('Control+Shift+P');
  await delay(350);
  
  console.log(`[CDP] Typing: ">${sanitizedCmd}"`);
  await page.keyboard.type(`>${sanitizedCmd}`, { delay: 25 });
  await delay(1000);
  await page.keyboard.press('Enter');

  console.log('[CDP] ✓ Command dispatched.');
  await browser.close();
}

/** launch-dev-host — F5 equivalent */
async function launchDevHost(passedBrowser = null) {
  console.log('[CDP] Triggering Extension Development Host (F5)...');
  const browser = passedBrowser || await connectToCDP();
  const page = await findWorkbenchPage(browser);

  if (!page) {
    console.error('[CDP] ✗ Workbench shell not found.');
    if (!passedBrowser) {await browser.close();}
    return false;
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
  if (passedBrowser) {
    return true; // Keep browser alive for shell
  } else {
    await browser.close();
    return true;
  }
}

/** stop-dev-host — Shift+F5 equivalent */
async function stopDevHost(passedBrowser = null) {
  console.log('[CDP] 🛑 Stopping active Debugging session (Shift+F5)...');
  const browser = passedBrowser || await connectToCDP();
  const page = await findWorkbenchPage(browser);

  if (!page) {
    console.warn('[CDP] ⚠ Workbench not found; cannot send Shift+F5.');
    if (!passedBrowser) {await browser.close();}
    return false;
  }

  await page.bringToFront();
  await page.keyboard.press('Escape'); // Clear any open dialogs
  await delay(100);
  await page.keyboard.down('Shift');
  await page.keyboard.press('F5');
  await page.keyboard.up('Shift');
  
  console.log('[CDP] ✓ Stop signal (Shift+F5) dispatched.');
  if (!passedBrowser) {await browser.close();}
  return true;
}

/** smarter-launch — Detects existing hosts and ensures a clean refresh */
async function smartLaunchDevHost(passedBrowser = null) {
  const browser = passedBrowser || await connectToCDP();
  const existingHosts = await findAllDevHosts(browser);

  if (existingHosts.length > 0) {
    console.log(`[CDP] 🔄 Smart Launch: ${existingHosts.length} active host(s) detected.`);
    console.log('[CDP] 🚿 Disinfecting environment before new launch...');
    
    // 1. Send Stop
    await stopDevHost(browser);
    
    // 2. Wait for processes to exit (max 5s)
    console.log('[CDP] ⏳ Waiting for stale processes to dissipate...');
    let attempts = 0;
    while (attempts < 5) {
      const remaining = await findAllDevHosts(browser);
      if (remaining.length === 0) {break;}
      await delay(1000);
      attempts++;
    }
  }

  // 3. Launch fresh
  return await launchDevHost(browser);
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

  const browser = await connectToCDP().catch(() => null);
  if (!browser) {
    console.error('[CDP] ✗ Cannot connect to CDP to close host.');
    process.exit(1);
  }

  // [SAFETY] Determine which PIDs are "Dev Host" vs "Main Agent Host"
  const allPids = snapshotAntigravityPids();

  // We identify the Main Host by finding the workbench that IS NOT an Extension Development Host
  const devHostPage = await findDevHostPage(browser);
  if (!devHostPage) {
    console.log('[CDP] ℹ️ No Extension Development Host found. Nothing to close.');
    await browser.close();
    return;
  }

  const mainPids = snapshotAntigravityPids();
  const devPids = [...allPids].filter(pid => !mainPids.has(pid));

  // If we can't find specific PIDs (e.g. they share the same base PID), 
  // we rely on the 3-tier polite close ladder which targets the specific CDP page.
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
    const tail = content.trimEnd().split('\n').slice(-lines).join('\n');
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
  const evalExpr = flags.eval ?? actionArg ?? null;

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
 *   targets             — list all CDP page targets
 *   eval <expr>         — evaluate JS expression in the Read Aloud webview
 *   exec <vs-cmd>       — execute a VS Code command via command palette
 *   log [n]             — print last n lines of diagnostics.log (default: 30)
 *   show read-aloud     — focus the sidebar and wake the extension
 *   find read-aloud     — verify the webview is present/detected
 *   exit / quit         — close everything and exit
 */
async function runShell() {
  // ── Shell Sovereignty ──
  if (existsSync(SHELL_LOCK)) {
    const oldPidStr = readFileSync(SHELL_LOCK, 'utf8').trim();
    const oldPid = parseInt(oldPidStr, 10);
    if (!isNaN(oldPid)) {
      try {
        // Check if the old PID is still alive
        process.kill(oldPid, 0);
        console.error('╔══════════════════════════════════════════════════════════════╗');
        console.error(`║  [SHELL] ✗ Another shell instance is active (PID: ${oldPid})    ║`);
        console.error('║  Aborting to prevent parallel CDP connection leakage.        ║');
        console.error('╚══════════════════════════════════════════════════════════════╝');
        process.exit(1);
      } catch (e) {

        // Process is dead, cleanup stale lock
        unlinkSync(SHELL_LOCK);
      }
    }
  }

  // Create lock
  writeFileSync(SHELL_LOCK, process.pid.toString());

  // 1. Core State Initialization
  const mainPids = snapshotAntigravityPids();
  let devHostPids = [];
  let browser = null; 
  let tailInterval = null;
  let tailLastSize = 0;

  // 2. Resource Disposal Logic
  const cleanupAndExit = async (code = 0) => {
    console.log('\n[SHELL] 🔻 Initiating resource cleanup...');
    stopTail();
    
    // [v2.4.3] Discovery + Graceful closure ritual: Tier 1 (Keyboard) -> Tier 2 (Eval) -> Tier 3 (Sigterm)
    if (browser) {
      // Refresh list to find any orphaned hosts launched manually or in previous sessions
      const allHosts = await findAllDevHosts(browser);
      const hostPids = new Set([...devHostPids]);
      
      // If we find any [Extension Development Host] targets not in our list, we'll let Tier 1/2 handle them
      // T3 (surgical kill) will only hit hostPids, which is safe.
      
      await gracefulClose(Array.from(hostPids), mainPids, browser);
      try { await browser.close(); } catch { }
      console.log('[SHELL] ✓ CDP browser connection closed.');
    } else if (devHostPids.length > 0) {
      console.log('[SHELL] ⚠ No browser connection; falling back to surgical kill.');
      surgicalPidKill(devHostPids, mainPids);
    }

    // 3. Lock Cleanup
    if (existsSync(SHELL_LOCK)) {
      try { unlinkSync(SHELL_LOCK); } catch { }
    }
    
    console.log(`[SHELL] 👋 Exiting with code ${code}`);
    process.exit(code);
  };

  // 3. Signal Handling
  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  CDP SHELL  —  Persistent debug session                      ║');
  console.log('║  Type "help" for commands.  Type "exit" to quit.             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Single persistent browser connection
  browser = await connectToCDP();
  console.log(`[SHELL] ✅ Connected to ${CDP_URL}`);
  console.log(`[SHELL] 🛡 Protected PIDs: ${[...mainPids].join(', ')}`);


  const startTail = () => {
    if (tailInterval) {return;} // already running
    try { tailLastSize = readFileSync(DIAG_LOG, 'utf8').length; } catch { tailLastSize = 0; }
    tailInterval = setInterval(() => {
      try {
        const content = readFileSync(DIAG_LOG, 'utf8');
        if (content.length > tailLastSize) {
          const fresh = content.slice(tailLastSize);
          const lines = fresh.split('\n').filter(Boolean);
          lines.forEach(processLogLine);
          tailLastSize = content.length;
        } else if (content.length < tailLastSize) {
          // File was rotated or cleared by extension
          processLogLine('--- [INTERNAL] Log File Truncated / Extension Restarted ---');
          tailLastSize = 0;
        }
      } catch { }
    }, 300);
    console.log('[SHELL] 📡 Log tail ON.');
  };

  const stopTail = () => {
    if (!tailInterval) {return;}
    clearInterval(tailInterval);
    tailInterval = null;
    console.log('[SHELL] Log tail OFF.');
  };

  /** Ensure browser is still connected; reconnect if not. */
  const getbrowser = async (forceRefresh = false) => {
    try {
      if (forceRefresh) {throw new Error('Force refresh');}
      // Ping: list contexts — throws if disconnected
      const ctxs = browser.contexts();
      if (ctxs.length === 0) {
        console.log('[SHELL] ⚠ 0 contexts detected. Attempting connection refresh...');
        throw new Error('Stale Contexts');
      }
      return browser;
    } catch {
      console.log('[SHELL] ⚡ Refreshing CDP connection...');
      cachedWebviewFrame = null; // [TOMBSTONE] Clear cache on refresh
      try { await browser.close(); } catch { }
      browser = await connectToCDP();
      browser.on('disconnected', () => { cachedWebviewFrame = null; }); // [TOMBSTONE] Reset on kill
      console.log('[SHELL] ✅ Connection refreshed.');
      return browser;
    }
  };

  const getAllPages = async () => {
    const b = await getbrowser();
    const all = [];
    for (const ctx of b.contexts()) {
      for (const page of ctx.pages()) {
        const title = await page.title().catch(() => 'Untitled');
        all.push({ page, title, url: page.url() });
      }
    }
    return all;
  };


  // ── Shell command handlers ────────────────────────────────────

  const shellHelp = () => {
    console.log('');
    console.log('  launch              — launch dev host (F5)');
    console.log('  close               — graceful 3-tier shutdown of dev host');
    console.log('  kill                — surgical PID kill (last resort)');
    console.log('  open read-aloud     — wake ritual: focus sidebar + attach webview');
    console.log('  find read-aloud     — verify the webview is present/detected');
    console.log('  check-host          — lightweight SitRep (connection status)');
    console.log('  sitrep              — deep SitRep (vitals, hydration, logs)');
    console.log('  targets             — list all CDP page targets');
    console.log('  pages               — list high-level workbench targets');
    console.log('  find-all            — exhaustive recursive frame audit');
    console.log('  refresh             — force-reconnect the CDP bridge');
    console.log('  eval <expr>         — evaluate JS in Read Aloud webview');
    console.log('  exec <vs-cmd>       — execute a VS Code command');
    console.log('  verify-state <expr> — poll until JS expression is true');
    console.log('  log [n]             — last n lines of diagnostics.log (default 30)');
    console.log('  tail                — toggle live log tail on/off');
    console.log('  wait-for-ready      — unified ritual: open + wait for hydration');
    console.log('  history [n]         — show last n entries from in-memory buffer');
    console.log('  refresh             — macro: reloadWindow + wait-for-ready');
    console.log('  exit | quit         — close shell and cleanup tracked hosts');
    console.log('');
  };

  const shellPages = async () => {
    const pages = await getAllPages();
    console.log(`\n[SHELL] ${pages.length} CDP page(s):`);
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const url = p.url;
      const title = p.title;
      let type = '[OTHER]     ';
      if (url.includes('workbench.html')) {type = '[WORKBENCH] ';}
      if (title.includes('Extension Development Host')) {type = '[DEV HOST]  ';}
      console.log(`  [${i}] ${type} "${title}"\n             ${url}`);
    }
    console.log('');
  };

  const shellTargets = async () => {
    const b = await getbrowser();
    console.log(`\n[SHELL] Active Contexts: ${b.contexts().length}`);
    for (const [i, ctx] of b.contexts().entries()) {
      const pCount = ctx.pages().length;
      console.log(`  Context [${i}]: ${pCount} pages`);
      for (const [j, p] of ctx.pages().entries()) {
        const title = await p.title().catch(() => 'Untitled');
        console.log(`    Page [${j}]: "${title}" -> ${p.url().slice(0, 100)}`);
      }
    }
    console.log('');
  };

  const shellCheckHost = async () => {
    const b = await getbrowser();
    const workbench = await findWorkbenchPage(b);
    const devHost = await findDevHostPage(b);
    const webview = await findWebviewFrame(b, true); // Verbose discovery in check-host

    console.log('\n[SHELL] 🔍 Connection SitRep:');
    console.log(`  Main Workbench: ${workbench ? '✅ Detected' : '❌ NOT FOUND'}`);
    console.log(`  Dev Host:       ${devHost ? '✅ Detected' : '❌ NOT FOUND (Launch required)'}`);
    console.log(`  Read Aloud UI:  ${webview ? '✅ Detected' : '❌ NOT FOUND (Show sidebar required)'}`);

    if (webview) {
      try {
        const hydration = await webview.evaluate(() => ({
          store: typeof window.__debug?.store?.getState === 'function',
          config: typeof window.__BOOTSTRAP_CONFIG__ === 'object',
          title: document.title
        }));
        console.log(`  UI Hydration:   ${hydration.store ? '✅ store' : '❌ NO STORE'} | ${hydration.config ? '✅ config' : '❌ NO CONFIG'}`);
      } catch (e) {
        console.log(`  UI Hydration:   ⚠ ERROR: ${e.message}`);
      }
    }

    if (workbench) {
      const title = await workbench.title().catch(() => 'Unknown');
      console.log(`  Active Editor:  "${title}"`);
    }
    console.log('');
  };

  const shellSitrep = async () => {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  SITUATION REPORT (v2.3.2 Hardening)                         ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');

    const b = await getbrowser(true); // Force refresh context
    const workbench = await findWorkbenchPage(b);
    const devHost = await findDevHostPage(b);
    const frame = await findWebviewFrame(b);

    console.log(`  [HOSTS]`);
    console.log(`    Workbench:    ${workbench ? '✅ (READY)' : '❌ (NOT FOUND)'}`);
    console.log(`    Dev Host:     ${devHost ? '✅ (LIVE)' : '❌ (LAUNCH REQ)'}`);

    if (frame) {
      console.log(`  [WEBVIEW]`);
      try {
        const vitals = await frame.evaluate(() => {
          const s = window.__debug?.store?.getState();
          return {
            isHydrated: !!s?.activeDocumentUri,
            isPlaying: !!s?.isPlaying,
            isPaused: !!s?.isPaused,
            file: s?.activeDocumentFileName || 'None',
            chapters: s?.allChapters?.length || 0
          };
        });
        console.log(`    Visibility:   ✅ (VISIBLE)`);
        console.log(`    Document:     "${vitals.file}"`);
        console.log(`    Hydration:    ${vitals.isHydrated ? `✅ (${vitals.chapters} chapters)` : '❌ (EMPTY)'}`);
        console.log(`    State:        ${vitals.isPlaying ? (vitals.isPaused ? '⏸️ PAUSED' : '▶️ PLAYING') : '⏹️ STOPPED'}`);
      } catch (e) {
        console.log(`    Visibility:   ⚠️ DETECTED BUT UNRESPONSIVE (${e.message})`);
      }
    } else {
      console.log(`  [WEBVIEW]       ❌ NOT DETECTED (Try "show read-aloud")`);
    }

    console.log(`  [DIAGNOSTICS]`);
    try {
      const content = readFileSync(DIAG_LOG, 'utf8');
      const lastLines = content.trim().split('\n').slice(-3);
      for (const line of lastLines) {
        console.log(`    > ${line.substring(0, 100)}`);
      }
    } catch {
      console.log(`    > No log entries found.`);
    }
    console.log('────────────────────────────────────────────────────────────────\n');
  };

  const shellLaunch = async () => {
    const before = snapshotAntigravityPids();
    const b = await getbrowser();
    
    // [v2.4.5] Smart Launch: Ensures no orphans are created
    const success = await smartLaunchDevHost(b);
    if (!success) {return;}

    console.log('[SHELL] Waiting for dev host PIDs...');
    const newPids = await waitForNewPids(before, 30000);
    // Add new PIDs to our tracked list
    devHostPids = Array.from(new Set([...devHostPids, ...newPids]));
    
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

  const shellNuke = async () => {
    const allPids = snapshotAntigravityPids();
    const targetPids = [...allPids].filter(pid => !mainPids.has(pid));
    if (targetPids.length === 0) {
      console.log('[SHELL] ✓ No stray Antigravity processes to nuke.');
      return;
    }
    console.log(`[SHELL] ☢️ NUKING ${targetPids.length} process tree(s)...`);
    surgicalPidKill(targetPids, mainPids);
  };

  const shellKill = async () => {
    const allPids = snapshotAntigravityPids();
    if (devHostPids.length > 0) {
      console.log(`[SHELL] ⚔ Killing tracked dev host PIDs...`);
      surgicalPidKill(devHostPids, mainPids);
      devHostPids = [];
    } else {
      console.log('[SHELL] 🛡 Filtering protected PIDs before surgical kill...');
      const targetPids = [...allPids].filter(pid => !mainPids.has(pid));
      if (targetPids.length === 0) {
        console.log('[SHELL] ✓ No stray Antigravity processes found. Main editor is safe.');
      } else {
        console.log(`[SHELL] ⚔ Killing ${targetPids.length} stray process(es)...`);
        surgicalPidKill(targetPids, mainPids);
      }
    }
  };

  /** 
  /** 
   * [v2.3.2] Sovereign RPC Bridge: Dispatch commands directly via Webview -> Extension RPC 
   * Bypasses the Command Palette (Ctrl+Shift+P) for high-integrity automation.
   */
  const shellExecDirectBound = async (cmdId, args = []) => {
    const b = await getbrowser();
    return await shellExecDirect(b, cmdId, args);
  };

  const shellExec = async (cmd) => {
    if (!cmd) { console.log('[SHELL] Usage: exec <vscode-command>'); return; }
    const b = await getbrowser();

    // [v2.3.2] Hybrid Sovereignty: Direct RPC vs. UI Simulation
    if (cmd.startsWith('readme-preview-read-aloud.')) {
      console.log(`[SHELL] ⚡ Direct RPC: ${cmd}`);
      try {
        const result = await shellExecDirectBound(cmd);
        console.log(`[SHELL] ✓ RPC Success${result ? ': ' + JSON.stringify(result) : ''}`);
        return;
      } catch (err) {
        console.warn(`[SHELL] ⚠ RPC Bridge failed: ${err.message}. Falling back to UI simulation...`);
      }
    }

    
    const devPage = await findDevHostPage(b);
    const mainPage = await findWorkbenchPage(b);

    // [v2.4.2] Sovereign Scoping: Strict target resolution
    const isProjectCmd = cmd.includes('readme-preview-read-aloud');
    let page = devPage;
    let context = '[DEV HOST]';

    if (!page) {
      if (isProjectCmd) {
        console.log('[SHELL] ✗ FAILED: Project commands MUST target the Dev Host.');
        console.log('[SHELL]   Main Editor is protected.');
        return;
      }
      page = mainPage;
      context = '[MAIN EDITOR]';
    }

    if (!page) {
      console.log('[SHELL] ✗ No active project window found (Main or Dev Host).');
      return;
    }

    // [v2.3.2] Offset-based response audit
    let initialOffset = 0;
    try { initialOffset = fs.statSync(DIAG_LOG).size; } catch (e) { }

    console.log(`[SHELL] ${context} exec: "${cmd}"`);

    // [v2.4.0] Strip redundant '>' prefix
    const sanitizedCmd = cmd.startsWith('>') ? cmd.substring(1) : cmd;

    await page.bringToFront().catch(() => { });
    await page.keyboard.press('Escape').catch(() => { });
    await delay(300); // Wait for modal context to clear
    await page.keyboard.press('Control+Shift+P').catch(() => { });
    await delay(600); // Wait for command palette animation

    // Clear palette before typing [v2.3.2]
    await page.keyboard.down('Control').catch(() => { });
    await page.keyboard.press('KeyA').catch(() => { });
    await page.keyboard.up('Control').catch(() => { });
    await page.keyboard.press('Backspace').catch(() => { });
    await delay(100);

    console.log(`[SHELL] Typing: ">${sanitizedCmd}"`);
    await page.keyboard.type(`>${sanitizedCmd}`, { delay: 30 }).catch(() => { });
    await delay(1500); // Increased wait for results to filter and match [v2.3.2]

    // [v2.4.3] Surgical Execution: Single-tap Enter.
    // The "Double-Tap" was the root cause of spontaneous playback triggers.
    await page.keyboard.press('Enter').catch(() => { }); 

    console.log('[SHELL] ✓ Command dispatched. Waiting for confirmation signals...');

    // Poll for new logs for up to 10 seconds [v2.3.2]
    const start = Date.now();
    let responseFound = false;
    while (Date.now() - start < 10000) {
      await delay(500);
      try {
        const logs = readFileSync(DIAG_LOG, 'utf8').substring(initialOffset);
        if (logs.includes('Command OK') || logs.includes('Sovereign Bridge') || logs.includes('Synthesis started') || logs.includes('STATE_SYNC_COMPLETE')) {
          console.log('[SHELL] ✓ Verification confirmed via logs.');
          responseFound = true;
          break;
        }
      } catch (e) { }
    }

    if (!responseFound) {
      console.warn('[SHELL] ⚠ No IDE response detected in logs within 10s.');
    }
  };

  /**
   * [v2.4.0] verify-state — Polls a JS expression in the webview until it returns true.
   */
  const shellVerifyState = async (expression, timeoutMs = 15000) => {
    if (!expression) { console.log('[SHELL] Usage: verify-state <JS expression>'); return; }
    const b = await getbrowser();
    const frame = await findWebviewFrame(b);
    if (!frame) {
      console.log('[SHELL] ❌ No webview frame found for verification.');
      return;
    }

    console.log(`[SHELL] 🔍 Verifying state: ${expression}`);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await frame.evaluate(expr => {
          try { return !!eval(expr); } catch { return false; }
        }, expression);
        if (result) {
          console.log(`[SHELL] ✅ Verification Success: ${expression}`);
          return true;
        }
      } catch (e) { }
      await delay(1000);
    }
    console.log(`[SHELL] ❌ Verification TIMEOUT (${timeoutMs}ms): ${expression}`);
    return false;
  };

  const shellShowReadAloud = async () => {
    console.log('[SHELL] 👁 Waking Read Aloud sidebar...');
    await shellExec('readme-preview-read-aloud.show-dashboard');
    console.log('[SHELL] ⏳ Waiting for hydration...');
    await delay(3000);
    cachedWebviewFrame = null;
    await findWebviewFrame(await getbrowser());
  };



  /** Exhaustive frame metadata dump */
  const shellFindAll = async () => {
    const b = await getbrowser();
    const pages = await getAllPages(b);
    console.log(`\n[SHELL] 🛡️ EXHAUSTIVE TARGET AUDIT (${pages.length} pages):`);
    for (const { page, title } of pages) {
      const frames = page.frames();
      console.log(`\n  Page: "${title}" [${page.url().substring(0, 60)}...]`);
      for (const f of frames) {
        const url = f.url();
        const info = await f.evaluate(() => ({
          store: typeof window.__debug?.store !== 'undefined',
          config: typeof window.__BOOTSTRAP_CONFIG__ !== 'undefined',
          scripts: Array.from(document.scripts).map(s => s.src.split('/').pop()).filter(Boolean).slice(0, 3)
        })).catch(() => ({ error: true }));

        const prefix = f.parentFrame() ? '    └─' : '  ';
        const storeTag = info.store ? '[STORE] ' : '';
        const configTag = info.config ? '[CONFIG] ' : '';
        console.log(`${prefix} Frame: ${url.substring(0, 80)}...`);
        if (info.scripts && info.scripts.length > 0) {
          console.log(`       ${storeTag}${configTag}Scripts: ${info.scripts.join(', ')}`);
        }
      }
    }
    console.log('');
  };

  const shellFrames = async () => {
    const b = await getbrowser();
    const pages = await getAllPages(b);
    console.log(`\n[SHELL] 📦 Recursive Frame Scan:`);
    for (const { page, title } of pages) {
      const frames = page.frames();
      console.log(`  Page: "${title}" (${frames.length} frames)`);
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const url = f.url();
        const prefix = f.parentFrame() ? '  └─' : '  ';
        console.log(`${prefix} [${i}] ${url.substring(0, 100)}`);
      }
    }
    console.log('');
  };

  const shellEval = async (expr) => {
    if (!expr) { console.log('[SHELL] Usage: eval <JS expression>'); return; }
    const b = await getbrowser();
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
        try { return JSON.stringify(eval(e), null, 2); } catch (err) { return `ERROR: ${err.message}`; }
      }, expr);
      console.log('[SHELL] 🔬 Result:');
      console.log(result);
    } catch (err) {
      console.log(`[SHELL] ✗ Eval failed: ${err.message}`);
    }
  };


  const shellLog = (nStr) => {
    const n = parseInt(nStr, 10) || 30;
    readDiagnosticsLog(n);
  };

  /** [v2.4.2] Wait-for-Log: Deterministic verification polling */
  const shellWaitForLog = async (pattern, timeoutMs = 15000) => {
    if (!pattern) { console.log('[SHELL] Usage: wait-for-log <regex-pattern>'); return; }
    console.log(`[SHELL] ⏳ Waiting for log pattern: /${pattern}/`);
    
    // [v2.4.2] Start checking from 10KB back to catch near-simultaneous events
    let lastSize = 0;
    try { 
      const stats = fs.statSync(DIAG_LOG);
      lastSize = Math.max(0, stats.size - 10240); 
    } catch (e) { }

    const start = Date.now();
    const patternUpper = pattern.replace(/^["']|["']$/g, '').toUpperCase(); 
    
    let lastLogTime = Date.now();
    let lastKnownSize = 0;

    while (Date.now() - start < timeoutMs) {
      try {
        const stats = fs.statSync(DIAG_LOG);
        const content = readFileSync(DIAG_LOG, 'utf8').toUpperCase();
        
        if (stats.size !== lastKnownSize) {
          lastLogTime = Date.now();
          lastKnownSize = stats.size;
        }

        const newPart = content.slice(lastSize);
        if (newPart.includes(patternUpper)) {
          console.log(`[SHELL] ✓ Pattern found: "${pattern}"`);
          return true;
        }

        // [v2.5.0] Heartbeat: Detect if logs have stalled for > 8s
        if (Date.now() - lastLogTime > 8000) {
          console.warn('[SHELL] ⚠ HEARTBEAT STALL: No log activity detected for 8s. System may be hung.');
          lastLogTime = Date.now(); // Reset to avoid constant spam
        }
      } catch (e) { }
      await new Promise(r => setTimeout(r, 800));
    }
    console.log(`[SHELL] ❌ TIMEOUT: Pattern /${pattern}/ not found in ${timeoutMs}ms.`);
    return false;
  };

  /** 
   * [INTERNAL] wait-for-ready: Unified High-Efficiency Ritual
   * Combines wake/open with hydration monitoring.
   */
  const shellWaitForReady = async () => {
    console.log('[SHELL] 🚀 Initiating Unified Ready Ritual...');
    await shellOpenReadAloud();
    console.log('[SHELL] ⏳ Polling for hydration signal (VOICE_SCAN SUCCESS)...');
    const hydrated = await shellWaitForLog('VOICE_SCAN SUCCESS', 10000);
    if (hydrated) {
      console.log('[SHELL] ✅ SYSTEM READY.');
    } else {
      console.log('[SHELL] ❌ HYDRATION TIMEOUT. Inspect logs for errors.');
    }
  };

  const shellShowHistory = (nStr) => {
    const n = parseInt(nStr, 10) || 100;
    const slice = inMemoryLogs.slice(-n);
    console.log(`\n[SHELL] 📜 Internal Forensic History (Last ${slice.length}):`);
    slice.forEach(l => console.log(`  ${l}`));
    console.log('--- END OF HISTORY ---\n');
  };

  const shellFullRefresh = async () => {
    console.log('[SHELL] 🔄 Initiating Full Environment Refresh...');
    await shellExec('workbench.action.reloadWindow');
    await delay(3000); // Wait for boot
    await shellWaitForReady();
  };

  const shellScanDevHosts = async () => {
    console.log('[SHELL] 🔍 Scanning for open Dev IDE instances...');
    // Force refresh to detect new targets
    const b = await getbrowser(true);
    const devHosts = await findAllDevHosts(b);
    
    if (devHosts.length === 0) {
      console.log('[SHELL] ✓ No open Extended Development Hosts detected.');
      return;
    }

    // Attempt to resolve PIDs via PowerShell for more informative display
    let pidMap = {};
    try {
        const psOut = execSync('powershell -NoProfile -Command "Get-Process Antigravity | Select-Object Id, MainWindowTitle | ConvertTo-Json"', { encoding: 'utf8' });
        const psProcs = JSON.parse(psOut);
        (Array.isArray(psProcs) ? psProcs : [psProcs]).forEach(p => {
            if (p && p.MainWindowTitle) { pidMap[p.MainWindowTitle] = p.Id; }
        });
    } catch { /* fallback to CDP only */ }

    console.log(`[SHELL] Found ${devHosts.length} instance(s):`);
    console.log('----------------------------------------------------------------------');
    devHosts.forEach((h, i) => {
      const displayPid = pidMap[h.title] || '?';
      console.log(`${i + 1}. [PID: ${displayPid}] TITLE: "${h.title}"`);
      console.log(`   URL: ${h.url.substring(0, 80)}...`);
    });
    console.log('----------------------------------------------------------------------');
  };

  const shellStatus = async () => {
    console.log('[SHELL] 📊 Environment Status:');
    console.log(`- Protected PIDs: ${Array.from(mainPids).join(', ')}`);
    const b = await getbrowser().catch(() => null);
    console.log(`- CDP Connection: ${b ? '✅ Active' : '❌ Offline'}`);
    await shellScanDevHosts();
  };

  const shellTail = () => {
    if (tailInterval) { stopTail(); } else { startTail(); }
  };

  // ── readline loop ────────────────────────────────────────────

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\ncdp> ',
    terminal: true,
  });

  rl.prompt();

  let commandQueue = Promise.resolve();

  rl.on('line', (raw) => {
    commandQueue = commandQueue.then(async () => {
      const line = raw.trim();
      if (!line) { rl.prompt(); return; }

      const lower = line.toLowerCase();
      if (lower === 'show read-aloud' || lower === 'open read-aloud') { await shellOpenReadAloud(); rl.prompt(); return; }

      // Support JSON-wrapped commands (e.g. from agent tools)
      let finalCmd = line;
      try {
        const parsed = JSON.parse(line);
        if (parsed.terminate) { finalCmd = 'exit'; }
        else if (parsed.command) { finalCmd = parsed.command; }
      } catch { /* not JSON, proceed normally */ }

      const [cmd, ...rest] = finalCmd.split(/\s+/);
      const arg = rest.join(' ');

      try {
        switch (cmd.toLowerCase()) {
          case '': break;
          case 'help': shellHelp(); break;
          case 'find':
            if (arg === 'read-aloud') { 
              const f = await findWebviewFrame(await getbrowser());
              console.log(`[SHELL] ${f ? '✅ Detected' : '❌ NOT FOUND'}`);
            } else {
              console.log('[SHELL] Usage: find read-aloud');
            }
            break;
          case 'check-host': await shellCheckHost(); break;
          case 'find-all': await shellFindAll(); break;
          case 'frames': await shellFrames(); break;
          case 'launch':
            const bLaunch = await getbrowser();
            await smartLaunchDevHost(bLaunch);
            break;

          case 'restart':
            const bRestart = await getbrowser();
            await smartLaunchDevHost(bRestart);
            break;
          case 'sitrep': await shellSitrep(); break;
          case 'close': await cleanupAndExit(0); break;
          case 'cleanup-all': 
            console.log('[SHELL] 🧹 Initiating Global Graceful Cleanup...');
            await shellScanDevHosts(); // Update PIDs
            await gracefulClose(devHostPids);
            devHostPids = [];
            break;

            case 'eval': await shellEval(arg); break;
          case 'exec': await shellExec(arg); break;
          case 'open': await shellOpenReadAloud(); break;
          case 'wait-for-ready': await shellWaitForReady(); break;
          case 'history': shellShowHistory(arg); break;
          case 'scan': await shellScanDevHosts(); break;
          case 'status': await shellStatus(); break;
          case 'refresh': await shellFullRefresh(); break;
          case 'wait-for-log': await shellWaitForLog(arg); break;
          case 'log': shellLog(arg); break;
          case 'tail': shellTail(); break;
          case 'verify-state': await shellVerifyState(arg); break;
          case 'exit':
          case 'quit':
            await cleanupAndExit(0);
            return;
          default:
            console.log(`[SHELL] Unknown command: "${cmd}". Type "help" for commands.`);
        }
      } catch (err) {
        console.log(`[SHELL] ✗ Error: ${err.message}`);
      }

      rl.prompt();
    });
  });

  rl.on('close', () => {
    cleanupAndExit(0);
  });

  // [v2.5.0] Robust signal handling for Ctrl+C and process termination
  process.on('SIGINT', async () => {
    console.log('\n[SHELL] 🛑 SIGINT received. Cleaning up...');
    await cleanupAndExit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[SHELL] 🛑 SIGTERM received. Cleaning up...');
    await cleanupAndExit(0);
  });
}

function printUsage() {
  console.log('[CDP] Usage: node scripts/cdp-controller.mjs <action> [arg] [--duration <ms>] [--eval <expr>]');
  console.log('[CDP] Actions:');
  console.log('[CDP]   shell (default)   — Open persistent CDP command shell (REPL)');
  console.log('[CDP]   list-targets      — show all CDP page targets');
  console.log('[CDP]   eval <expr>       — evaluate JS in the live Read Aloud webview');
  console.log('');
  console.log('[CDP] Flags:');
  console.log('[CDP]   --duration <ms>   — Set delay (for observe-cycle)');
  console.log('[CDP]   --eval <expr>     — Javascript to evaluate in webview context');
  console.log('[CDP]   --log             — Write detailed diagnostics to scripts/logs/diagnostics.log');
}

// ─────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────

if (!action) { printUsage(); process.exit(1); }

switch (action) {
  case 'shell':
    runShell();
    break;

  case 'launch-dev-host':
    launchDevHost();
    break;

  case 'wait-for-devhost':
    waitForDevHostAction();
    break;

  case 'close-dev-host':
    closeDevHostAction();
    break;

  case 'exec-command':
    if (!actionArg) {
      console.error('[CDP] ERROR: command name required.');
      process.exit(1);
    }
    execVSCodeCommand(actionArg);
    break;

  case 'list-targets':
    listTargets();
    break;

  case 'scan':
    (async () => {
      const b = await connectToCDP();
      const devHosts = await findAllDevHosts(b);
      console.log(`[CDP] Found ${devHosts.length} instance(s)`);
      devHosts.forEach((h, i) => console.log(`${i+1}. ${h.title}`));
      await b.close();
    })();
    break;

  case 'restart':
    (async () => {
      const bRes = await connectToCDP();
      await smartLaunchDevHost(bRes);
      await bRes.close();
    })();
    break;

  case 'status':
    (async () => {
      const b = await connectToCDP();
      console.log('[CDP] 📊 Environment Status:');
      const pages = await getAllPages(b);
      console.log(`- CDP Connection: ✅ Active`);
      console.log(`- Discovery: ${pages.length} targets found.`);
      await b.close();
    })();
    break;

  case 'tail':
    (async () => {
      const b = await connectToCDP();
      console.log('[CDP] 👁 Streaming Forensic Tail (Ctrl+C to stop)...');
      await getAllPages(b); // Hook all targets
      // Persistent loop for top-level tail
      process.on('SIGINT', async () => {
        await b.close();
        process.exit();
      });
      // Keep process alive

    })();
    break;

  case 'eval':
  case 'eval-webview':
    const expr = flags.eval || actionArg;
    if (!expr) {
      console.error('[CDP] ERROR: JS expression required.');
      process.exit(1);
    }
    evalWebview(expr);
    break;

  default:
    console.log(`[CDP] Unknown action: ${action}`);
    printUsage();
    process.exit(1);
}
