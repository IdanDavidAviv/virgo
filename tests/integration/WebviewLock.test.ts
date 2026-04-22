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

    it('should ABORT the waiting lock acquisition after 3s safety timeout to prevent dual-owner hang', async () => {
        console.log('[TEST] Simulating a "Zombie" lock hold in Webview...');
        
        // 1. Acquire first lock and ZOMBIE IT (never call unlock)
        const unlock1 = await webviewEngine.acquireLock();
        expect(unlock1).toBeDefined();
        
        // 2. Attempt to acquire second lock — should hang without the timeout
        const lockPromise2 = webviewEngine.acquireLock();

        console.log('[TEST] Advancing past 3s safety limit...');
        await vi.advanceTimersByTimeAsync(4000); // Cross 3s threshold

        // 3. Verify the waiter was ABORTED (returns null), not granted the lock.
        // Granting the lock while the zombie holder is still active causes dual
        // ownership of HTMLAudioElement → duplicate loadstart + canplay events.
        // Returning null is safe: the caller treats it as "give up, try later."
        const unlock2 = await lockPromise2;
        expect(unlock2).toBeNull();
        
        console.log('[TEST] ✅ Waiter correctly aborted by safety timeout — no dual-owner risk.');
    });
});
