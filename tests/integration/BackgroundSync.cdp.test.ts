/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execSync } from 'child_process';

// Inline OOPIF Target resolution helper classes & methods to support Playwright connections
class TargetProxy {
    constructor(
        private browser: any,
        private targetId: string,
        private _url: string,
        private frameIndex: number | null = null
    ) {}
    
    url() { return this._url; }
    
    async evaluate(fn: any, arg?: any): Promise<any> {
        const browserSession = await this.browser.newBrowserCDPSession();
        const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId: this.targetId, flatten: false });
        
        let expression = typeof fn === 'function' 
            ? `(${fn.toString()})(${JSON.stringify(arg)})`
            : fn;

        if (this.frameIndex !== null) {
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
            const handler = (params: any) => {
                if (params.sessionId === sessionId) {
                    try {
                        const res = JSON.parse(params.message);
                        if (res.id === messageId) {
                            browserSession.off('Target.receivedMessageFromTarget', handler);
                            if (res.error) { reject(new Error(res.error.message)); }
                            else if (res.result.exceptionDetails) { reject(new Error(res.result.exceptionDetails.exception.description)); }
                            else { resolve(res.result.result.value); }
                        }
                    } catch (e) { /* ignore parse errors */ }
                }
            };
            browserSession.on('Target.receivedMessageFromTarget', handler);
            await browserSession.send('Target.sendMessageToTarget', { sessionId, message });
        });
    }
}

function getRawTargets(): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const req = http.get("http://localhost:9222/json", (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e: any) { reject(new Error(`getRawTargets: JSON parse failed — ${e.message}`)); }
            });
        });
        req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error('getRawTargets: HTTP timeout after 5000ms'));
        });
        req.on('error', reject);
    });
}

async function findSovereignTarget(browser: any, type: string, verbose = false, env: string | null = null): Promise<any> {
    if (type === 'webview') {
        const CONFIG_markers_host = 'Extension Development Host';
        const CONFIG_markers_hostArg = 'extensionDevelopmentPath';

        try {
            const rawTargets = await getRawTargets();
            const hostTargets = rawTargets.filter(t => t.title.includes(CONFIG_markers_host));
            
            for (const ht of hostTargets) {
                const isDevHost = ht.url.includes(CONFIG_markers_hostArg) || ht.title.includes(CONFIG_markers_host);
                if (env === 'dev' && !isDevHost) { continue; }

                const webviewTargets = rawTargets.filter(t => 
                    (t.type === 'iframe' || t.type === 'webview') && 
                    t.parentId === ht.id
                );
                
                let webviewTarget = webviewTargets.find(t => t.url.includes('speech-engine') || t.url.includes('readme'));
                if (!webviewTarget) { webviewTarget = webviewTargets.find(t => t.url.includes('purpose=webviewView')); }
                if (!webviewTarget) { webviewTarget = webviewTargets[0]; }
                
                if (webviewTarget) {
                    return new TargetProxy(browser, webviewTarget.id, webviewTarget.url, 0); // 0 index represents content frame
                }
            }
        } catch (e: any) {
            if (verbose) { console.warn(`[CDP] OOPIF resolution failed: ${e.message}`); }
        }
    }
    return null;
}

// Helper to check if CDP port 9222 is active before running tests
const checkCdpPortSync = (): boolean => {
    try {
        execSync('node -e "require(\'http\').get(\'http://localhost:9222/json/version\', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on(\'error\', () => process.exit(1))"', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

const isCdpActive = checkCdpPortSync();

describe.runIf(isCdpActive)('T-111 Live Background Sync & User Interactions (CDP)', () => {
    let browser: any;
    let webviewFrame: any;
    let devHostWorkbench: any;
    let activeSnippetFile: string = "";

    beforeAll(async () => {
        browser = await chromium.connectOverCDP("http://localhost:9222");
        const allPages = await browser.contexts()[0].pages();
        
        for (const page of allPages) {
            const url = page.url();
            const title = await page.title();
            if (url.includes("workbench.html") && title.includes("[Extension Development Host]")) {
                devHostWorkbench = page;
                break;
            }
        }

        if (!devHostWorkbench) {
            throw new Error("Extension Development Host workbench not found!");
        }

        webviewFrame = await findSovereignTarget(browser, 'webview', false, 'dev');

        // Self-healing: if not found, reveal Virgo dashboard
        if (!webviewFrame) {
            console.log("[CDP Test] Webview not found. Attempting to reveal Virgo dashboard...");
            await devHostWorkbench.bringToFront();
            await devHostWorkbench.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 200));
            await devHostWorkbench.keyboard.press('Control+Shift+P');
            await new Promise(r => setTimeout(r, 400));
            await devHostWorkbench.keyboard.type("Virgo: Show Virgo Dashboard", { delay: 20 });
            await new Promise(r => setTimeout(r, 500));
            await devHostWorkbench.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 3000));
            webviewFrame = await findSovereignTarget(browser, 'webview', false, 'dev');
        }

        if (!webviewFrame) {
            throw new Error("Hydrated extension webview target not found!");
        }

        // Resolve the active watch folder from diagnostics_agent.log to prevent path mismatch
        let sessionsRoot = "";
        try {
            const logPath = path.join(process.cwd(), 'diagnostics_agent.log');
            if (fs.existsSync(logPath)) {
                const logs = fs.readFileSync(logPath, 'utf8');
                const matches = [...logs.matchAll(/\[MCP_WATCHER\] External fs\.watch active on (.*)/g)];
                if (matches.length > 0) {
                    sessionsRoot = matches[matches.length - 1][1].trim();
                    console.log(`[CDP Test] Resolved active watch root from diagnostics log: ${sessionsRoot}`);
                }
            }
        } catch (e) {
            console.error("[CDP Test] Failed to parse diagnostics_agent.log:", e);
        }

        if (!sessionsRoot) {
            const possibleRoots = [
                "C:/Users/Idan4/.gemini/antigravity/virgo/sessions",
                "C:/Users/Idan4/.gemini/antigravity-ide/virgo/sessions"
            ];
            for (const root of possibleRoots) {
                if (fs.existsSync(root)) {
                    sessionsRoot = root;
                    break;
                }
            }
            if (!sessionsRoot) {
                sessionsRoot = possibleRoots[0];
            }
            console.log(`[CDP Test] Fallback sessions root resolved: ${sessionsRoot}`);
        }

        const activeSessionId = await webviewFrame.evaluate(() => {
            return (window as any).__debug.store.getState().activeSessionId;
        });

        console.log(`[CDP Test] Active session ID resolved: ${activeSessionId}`);

        const resolvedSessionPath = path.join(sessionsRoot, activeSessionId);
        if (!fs.existsSync(resolvedSessionPath)) {
            fs.mkdirSync(resolvedSessionPath, { recursive: true });
        }

        const ts = Date.now();
        activeSnippetFile = path.join(resolvedSessionPath, `${ts}.cdp_test.md`);
        console.log(`[CDP Test] Resolved target snippet file path: ${activeSnippetFile}`);
    }, 60000);

    afterAll(async () => {
        if (browser) {
            await browser.close();
        }
        if (activeSnippetFile && fs.existsSync(activeSnippetFile)) {
            fs.unlinkSync(activeSnippetFile);
        }
    });

    it('should successfully sync snippet history updates in the background when the view is hidden', async () => {
        // 1. Get baseline count
        const baseline = await webviewFrame.evaluate(() => {
            const s = (window as any).__debug.store.getState();
            const activeSession = s.snippetHistory.find((h: any) => h.id === s.activeSessionId);
            return activeSession ? activeSession.snippets.length : 0;
        });

        // 2. Hide sidebar
        console.log("[CDP Test] Hiding sidebar...");
        await devHostWorkbench.bringToFront();
        await devHostWorkbench.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 200));
        await devHostWorkbench.keyboard.press('Control+Shift+P');
        await new Promise(r => setTimeout(r, 400));
        await devHostWorkbench.keyboard.type("View: Close Primary Side Bar", { delay: 20 });
        await new Promise(r => setTimeout(r, 500));
        await devHostWorkbench.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 1000));

        // 3. Write new snippet
        const testText = `CDP Auto-Test snippet at ${new Date().toLocaleTimeString()}`;
        const fileContent = `# CDP Test Snippet\n\n${testText}`;
        fs.writeFileSync(activeSnippetFile, fileContent);
        console.log(`[CDP Test] Injected snippet: ${activeSnippetFile}`);

        // 4. Wait for watcher and sync
        await new Promise(r => setTimeout(r, 3500));

        // 5. Audit webview state while hidden
        const postSyncCount = await webviewFrame.evaluate(() => {
            const s = (window as any).__debug.store.getState();
            const activeSession = s.snippetHistory.find((h: any) => h.id === s.activeSessionId);
            return activeSession ? activeSession.snippets.length : 0;
        });

        // 6. Restore sidebar
        console.log("[CDP Test] Restoring sidebar...");
        await devHostWorkbench.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 200));
        await devHostWorkbench.keyboard.press('Control+Shift+P');
        await new Promise(r => setTimeout(r, 400));
        await devHostWorkbench.keyboard.type("Virgo: Show Virgo Dashboard", { delay: 20 });
        await new Promise(r => setTimeout(r, 500));
        await devHostWorkbench.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 1000));

        expect(postSyncCount).toBe(baseline + 1);
    }, 45000);

    it('should emulate a user click on the play button and verify playing state', async () => {
        // Focus the sidebar first
        await devHostWorkbench.bringToFront();
        
        // Emulate user mousedown gesture to satisfy userHasInteracted gate
        await webviewFrame.evaluate(() => {
            const event = new MouseEvent('mousedown', { view: window, bubbles: true, cancelable: true });
            document.dispatchEvent(event);
        });

        // Click on play button
        const btnPlayFound = await webviewFrame.evaluate(() => {
            const btn = document.getElementById('btn-play');
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        });

        expect(btnPlayFound).toBe(true);

        // Wait a moment for audio element and Redux state to transition
        await new Promise(r => setTimeout(r, 1200));

        const isPlaying = await webviewFrame.evaluate(() => {
            const s = (window as any).__debug.store.getState();
            return s.isPlaying;
        });

        // Stop playback defensively to avoid running audio
        await webviewFrame.evaluate(() => {
            const btn = document.getElementById('btn-stop') || document.getElementById('btn-pause');
            if (btn) {btn.click();}
        });

        expect(isPlaying).toBe(true);
    }, 25000);
});
