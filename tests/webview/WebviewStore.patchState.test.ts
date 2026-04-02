/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '@webview/core/WebviewStore';
import { MessageClient } from '@webview/core/messageClient';
import { IncomingCommand, UISyncPacket } from '@common/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dispatchSync(data: Partial<UISyncPacket>) {
    window.dispatchEvent(new MessageEvent('message', {
        data: { command: IncomingCommand.UI_SYNC, ...data }
    }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebviewStore — patchState (#2 regression guard)', () => {
    let store: WebviewStore;

    beforeEach(() => {
        (window as any).vscode = null;
        (window as any).acquireVsCodeApi = vi.fn(() => ({ postMessage: vi.fn() }));
        MessageClient.resetInstance();
        WebviewStore.resetInstance();
        store = WebviewStore.getInstance();
    });

    it('should be a no-op if no base state exists yet', () => {
        // patchState before any UI_SYNC — should not throw
        expect(() => store.patchState({ isPlaying: true })).not.toThrow();
        expect(store.getState()).toBeNull();
    });

    it('should merge a partial patch into existing state', () => {
        dispatchSync({ isPlaying: false, isPaused: false, rate: 0 });
        const voicePatch = {
            availableVoices: { neural: ['VoiceA'], local: [] },
            selectedVoice: 'VoiceA',
            engineMode: 'neural' as const
        };

        store.patchState(voicePatch);

        expect(store.getState()?.availableVoices?.neural).toEqual(['VoiceA']);
        expect(store.getState()?.selectedVoice).toBe('VoiceA');
        // Un-patched fields are preserved
        expect(store.getState()?.isPlaying).toBe(false);
        expect(store.getState()?.rate).toBe(0);
    });

    it('should notify subscribers whose selected slice changed', () => {
        dispatchSync({ isPlaying: false, availableVoices: { neural: [], local: [] } });

        const listener = vi.fn();
        store.subscribe((s) => s.availableVoices?.neural, listener);
        vi.clearAllMocks(); // ignore immediate call on subscribe

        store.patchState({
            availableVoices: { neural: ['ShinyVoice'], local: [] }
        });

        expect(listener).toHaveBeenCalledWith(['ShinyVoice']);
    });

    it('should NOT notify subscribers whose selected slice did NOT change', () => {
        dispatchSync({ isPlaying: false, rate: 5 });

        const listener = vi.fn();
        store.subscribe((s) => s.isPlaying, listener);
        vi.clearAllMocks();

        // Patch something unrelated
        store.patchState({ rate: 10 });

        expect(listener).not.toHaveBeenCalled();
    });

    it('should preserve all existing fields when patching a single field', () => {
        dispatchSync({
            isPlaying: true,
            isPaused: false,
            rate: 3,
            volume: 80,
            engineMode: 'neural' as const
        });

        store.patchState({ selectedVoice: 'NewVoice' });

        const state = store.getState()!;
        expect(state.isPlaying).toBe(true);
        expect(state.rate).toBe(3);
        expect(state.volume).toBe(80);
        expect(state.engineMode).toBe('neural');
        expect(state.selectedVoice).toBe('NewVoice');
    });
});
