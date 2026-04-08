/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';

describe('Webview Resilience Integration - Lock Sovereignty', () => {
    let clientMocks: any;
    let webviewEngine: WebviewAudioEngine;

    beforeEach(() => {
        vi.useFakeTimers();
        
        // Mock global VS Code API if needed by dependencies
        (global as any).acquireVsCodeApi = () => ({
            postMessage: vi.fn(),
            getState: vi.fn(),
            setState: vi.fn()
        });

        // Reset singleton
        // @ts-ignore
        WebviewAudioEngine.instance = undefined;
        webviewEngine = WebviewAudioEngine.getInstance();
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (global as any).acquireVsCodeApi;
    });

    it('should FORCIBLY release playback lock after 3s safety timeout (Test Env) to prevent system hang', async () => {
        console.log('[TEST] Simulating a "Zombie" lock hold in Webview...');
        
        // 1. Acquire first lock and ZOMBIE IT (never call unlock)
        const unlock1 = await webviewEngine.acquireLock();
        expect(unlock1).toBeDefined();
        
        // 2. Attempt to acquire second lock - this SHOULD hang indefinitely WITHOUT the safety timeout
        const lockPromise2 = webviewEngine.acquireLock();
        
        // Check state at 8s
        let lockAcquired = false;
        lockPromise2.then(() => { lockAcquired = true; });

        console.log('[TEST] Advancing past 3s safety limit...');
        await vi.advanceTimersByTimeAsync(4000); // Cross 3s threshold (0s + 4s = 4s)
        
        // 3. Verify it unfroze and returned a valid unlock function
        const unlock2 = await lockPromise2;
        expect(unlock2).toBeDefined();
        expect(typeof unlock2).toBe('function');
        
        console.log('[TEST] ✅ Lock unblocked by safety timeout.');
    });
});
