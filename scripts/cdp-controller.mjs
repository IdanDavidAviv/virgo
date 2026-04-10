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
 *   node scripts/cdp-controller.mjs kill-dev-host
 *   node scripts/cdp-controller.mjs probe-cycle
 *   node scripts/cdp-controller.mjs exec-command "<cmd>"
 */

import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CDP_URL    = 'http://localhost:9222';
const DIAG_LOG   = resolve(__dirname, '..', 'diagnostics.log');
const action     = process.argv[2];
const actionArg  = process.argv[3];

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
 *
 * LAW: The real workbench shell always loads workbench.html.
 *      Preview tabs, Launchpad, and agent panels use about:blank or other URLs.
 *      NEVER match on title alone — preview tabs also contain "Antigravity" in their title.
 */
async function findWorkbenchPage(browser) {
  const pages = await getAllPages(browser);
  for (const { page, title, url } of pages) {
    const isDevHost  = title.includes('Extension Development Host');
    const isWebview  = url.includes('vscode-webview');
    const isRealShell = url.includes('workbench.html');
    if (isRealShell && !isDevHost && !isWebview) {return page;}
  }
  return null;
}

/**
 * Snapshots all current Antigravity PIDs (no elevation required).
 */
function snapshotAntigravityPids() {
  try {
    const raw = execSync("powershell -NoProfile -Command \"Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id\"", { encoding: 'utf8' }).trim();
    return new Set(raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number));
  } catch {
    return new Set();
  }
}

/**
 * Polls until new Antigravity PIDs appear (delta from beforePids snapshot).
 * Pure PID delta — no WMI, no elevation, no title matching.
 * Returns the array of new PIDs (the debug host processes).
 */
async function waitForDevHost(_browser, beforePids, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = snapshotAntigravityPids();
    const newPids  = [...current].filter(pid => !beforePids.has(pid));
    if (newPids.length > 0) return newPids;
    await delay(1000);
  }
  throw new Error('[CDP] ✗ Timed out waiting for Extension Development Host.');
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
  await delay(1000);  // wait for palette to fully filter before confirming
  await page.keyboard.press('Enter');

  console.log('[CDP] ✓ Command dispatched.');
  await browser.close();
}

/** launch-dev-host — F5 equivalent
 *  Two-step flow:
 *    Step 1: Ctrl+Shift+P → "Debug: Start Debugging" → Enter (runs the command)
 *    Step 2: Config picker appears with "Extension (Dev)" highlighted → Enter (confirms)
 */
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
  await delay(1000);  // wait for palette to fully filter
  await page.keyboard.press('Enter');
  console.log('[CDP] Step 1: "Debug: Start Debugging" dispatched.');

  // Step 2: Config picker appears — "Extension (Dev)" is already highlighted (Most Recent)
  await delay(600);
  await page.keyboard.press('Enter');
  console.log('[CDP] Step 2: Config picker confirmed (Extension Dev).');

  console.log('[CDP] ✓ Dev host launch dispatched.');
  await browser.close();
}

/** wait-for-devhost — blocks until [Extension Development Host] appears */
async function waitForDevHostAction() {
  console.log('[CDP] Waiting for Extension Development Host to appear...');
  const browser = await connectToCDP();
  try {
    const title = await waitForDevHost(browser, 30000);
    console.log(`[CDP] ✓ Dev host is up: "${title}"`);
  } finally {
    await browser.close();
  }
}

/**
 * kill-dev-host — surgical termination via PID snapshot delta.
 * Kills ONLY the PIDs that appeared after the pre-launch snapshot.
 * Zero collateral damage: main editor PIDs are never touched.
 */
function killDevHost(devHostPids) {
  if (!devHostPids || devHostPids.length === 0) {
    console.log('[CDP] No dev host PIDs to kill.');
    return;
  }
  console.log(`[CDP] Surgical kill: terminating ${devHostPids.length} debug host process(es)...`);
  for (const pid of devHostPids) {
    try {
      execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`, { encoding: 'utf8' });
      console.log(`[CDP] ✓ Killed PID ${pid}`);
    } catch (err) {
      console.warn(`[CDP] ⚠ Could not kill PID ${pid}: ${err.message}`);
    }
  }
  console.log('[CDP] Dev host(s) terminated.');
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
 * probe-cycle — the full autonomous agent loop:
 *   1. Launch dev host (F5 equivalent)
 *   2. Wait for [Extension Development Host] to appear
 *   3. Report dev host alive
 *   4. Kill dev host
 *   5. Read diagnostics.log tail
 */
async function probeCycle() {
  console.log('[CDP] ══ PROBE CYCLE START ══════════════════════════════════════');

  // Snapshot existing PIDs BEFORE launch — anything new afterward = dev host
  const beforePids = snapshotAntigravityPids();
  console.log(`[CDP] Pre-launch snapshot: ${beforePids.size} Antigravity process(es).`);

  // Step 1: Launch
  console.log('[CDP] [1/4] Launching Extension Development Host...');
  await launchDevHost();

  // Step 2: Wait for new PIDs to appear (pure delta)
  console.log('[CDP] [2/4] Waiting for dev host to boot (max 30s)...');
  const browser = await connectToCDP();
  let devHostPids;
  try {
    devHostPids = await waitForDevHost(browser, beforePids, 30000);
    console.log(`[CDP] ✓ Dev host is live — new PID(s): ${devHostPids.join(', ')}`);
  } finally {
    await browser.close();
  }

  // Step 3: Give extension a moment to initialize
  console.log('[CDP] [3/4] Waiting 3s for extension activation...');
  await delay(3000);

  // Step 4: Surgical kill — only the new PIDs from pre-launch delta
  console.log('[CDP] [4/4] Killing dev host...');
  killDevHost(devHostPids);

  // Step 5: Read log
  readDiagnosticsLog(30);

  console.log('[CDP] ══ PROBE CYCLE COMPLETE ════════════════════════════════════');
}

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printUsage() {
  console.error('[CDP] Usage: node scripts/cdp-controller.mjs <action> [arg]');
  console.error('[CDP] Actions:');
  console.error('[CDP]   list-targets              — show all CDP page targets');
  console.error('[CDP]   launch-dev-host           — trigger dev host (F5 equivalent)');
  console.error('[CDP]   wait-for-devhost          — block until dev host appears');
  console.error('[CDP]   kill-dev-host             — terminate the dev host window');
  console.error('[CDP]   probe-cycle               — full: launch → wait → kill → read log');
  console.error('[CDP]   exec-command "<name>"     — execute any command via command palette');
}

// ─────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────

if (!action) { printUsage(); process.exit(1); }

switch (action) {
  case 'list-targets':      listTargets();           break;
  case 'launch-dev-host':   launchDevHost();         break;
  case 'wait-for-devhost':  waitForDevHostAction();  break;
  case 'kill-dev-host':     killDevHost();           break;
  case 'probe-cycle':       probeCycle();            break;
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
