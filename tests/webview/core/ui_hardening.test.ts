/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebviewStore, DEFAULT_SYNC_PACKET } from '../../../src/webview/core/WebviewStore';
import { WebviewAudioEngine } from '../../../src/webview/core/WebviewAudioEngine';
import { MessageClient } from '../../../src/webview/core/MessageClient';
import { IncomingCommand, UISyncPacket } from '../../../src/common/types';

// Mock VS Code API
(window as any).acquireVsCodeApi = () => ({
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
});

describe('Webview UI Hardening (v2.3.1)', () => {
    let store: WebviewStore;
    let engine: WebviewAudioEngine;
    let client: MessageClient;

    beforeEach(() => {
        // Reset singletons properly
        (WebviewStore as any).instance = null;
        (WebviewAudioEngine as any).instance = null;
        (MessageClient as any).instance = null;

        store = WebviewStore.getInstance();
        engine = WebviewAudioEngine.getInstance();
        client = MessageClient.getInstance();
        
        // Clear mocks
        vi.clearAllMocks();
    });

    describe('MessageClient Sanitization', () => {
        it('should sanitize UI_SYNC packets with missing numeric fields', async () => {
            const malformedPacket: any = {
                command: IncomingCommand.UI_SYNC,
                currentChapterIndex: undefined,
                currentSentenceIndex: undefined,
                volume: undefined
            };

            const promise = new Promise<UISyncPacket>(resolve => {
                client.onCommand(IncomingCommand.UI_SYNC, (sanitized: UISyncPacket) => {
                    resolve(sanitized);
                });
            });

            // Simulate window message
            window.dispatchEvent(new MessageEvent('message', {
                data: malformedPacket
            }));

            const sanitized = await promise;
            expect(sanitized.currentChapterIndex).toBe(0);
            expect(sanitized.currentSentenceIndex).toBe(0);
            expect(sanitized.volume).toBe(50);
        });

        it('should handle UI_SYNC missing numeric fields entirely', async () => {
           const emptyPacket: any = {
                command: IncomingCommand.UI_SYNC
            };

            const promise = new Promise<UISyncPacket>(resolve => {
                client.onCommand(IncomingCommand.UI_SYNC, (sanitized: UISyncPacket) => {
                    resolve(sanitized);
                });
            });

            window.dispatchEvent(new MessageEvent('message', {
                data: emptyPacket
            }));

            const sanitized = await promise;
            expect(sanitized.currentChapterIndex).toBe(0);
            expect(sanitized.currentSentenceIndex).toBe(0);
        });
    });

    describe('WebviewStore Flat State Purity', () => {
        it('should update top-level properties correctly', () => {
            store.patchState({
                currentChapterIndex: 10
            });

            expect(store.getState().currentChapterIndex).toBe(10);
            // Verify NO state object exists
            expect((store.getState() as any).state).toBeUndefined();
        });

        it('should fix "Ghost State" by reflecting currentSentenceIndex at top level', () => {
            store.patchState({
                currentSentenceIndex: 42
            });
            expect(store.getState().currentSentenceIndex).toBe(42);

            store.patchState({
                currentSentenceIndex: 0
            });
            expect(store.getState().currentSentenceIndex).toBe(0);
        });
    });

    describe('WebviewAudioEngine Abortable Intent', () => {
        it('should immediately abort previous intent wait when a newer intent arrives', async () => {
            // 1. Acquire lock for intent 100
            const release1 = await engine.acquireLock(100);
            expect(release1).toBeDefined();

            // Give a tiny gap to ensure intent 100 has fully returned before 101 arrives
            await new Promise(r => setTimeout(r, 0));

            // 2. Start waiting for lock for intent 101 (will be blocked by 100)
            const lockPromise101 = engine.acquireLock(101);

            // 3. New intent 102 arrives. This should abort the wait for 101.
            const release102Promise = engine.acquireLock(102);

            // Wait for internal microtasks and mutex race
            await new Promise(r => setTimeout(r, 50));

            const release101 = await lockPromise101;
            // 101 should be discarded/rejected because 102 aborted it
            expect(release101).toBeNull();

            // Cleanup
            if (release1) {release1();}
            const release102 = await release102Promise;
            expect(release102).toBeDefined();
            if (release102) {release102();}
        });

        it('should abort active playback when a new intent is received', async () => {
            const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
            const pauseSpy = vi.spyOn(engine['_audio'], 'pause');

            // Simulate playBlob starting
            const blob = new Blob(['test'], { type: 'audio/mpeg' });
            const playPromise = engine.playBlob(blob, 'test', 500);

            await new Promise(r => setTimeout(r, 10)); // Let it start

            // Receive new intent
            await engine.acquireLock(501);

            expect(pauseSpy).toHaveBeenCalled();
            
            // The previous play should resolve (locks are released)
            await playPromise;
        });
    });
});
