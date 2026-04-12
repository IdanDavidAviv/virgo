/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '@webview/core/WebviewStore';
import { IncomingCommand, UISyncPacket } from '@common/types';
import { resetAllSingletons, wireDispatcher } from './testUtils';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dispatchSync(data: Partial<UISyncPacket>) {
    window.dispatchEvent(new MessageEvent('message', {
        data: { 
            command: IncomingCommand.UI_SYNC, 
            currentSentenceIndex: 0,
            playbackIntentId: 1,
            batchIntentId: 1,
            ...data 
        }
    }));
}

function dispatchVoices(voices: any[], neural: any[]) {
    window.dispatchEvent(new MessageEvent('message', {
        data: {
            command: IncomingCommand.VOICES,
            voices,
            neuralVoices: neural
        }
    }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebviewStore — patchState (#2 regression guard)', () => {
    let store: WebviewStore;

    beforeEach(() => {
        (window as any).vscode = null;
        (window as any).acquireVsCodeApi = vi.fn(() => ({ postMessage: vi.fn() }));
        resetAllSingletons();
        wireDispatcher();
        store = WebviewStore.getInstance();
    });

    it('should be a no-op if no base state exists yet', () => {
        // patchState before any UI_SYNC — should now hydrate from DEFAULT_SYNC_PACKET
        expect(() => store.patchState({ isPlaying: true })).not.toThrow();
        expect(store.getState()).not.toBeNull();
        expect(store.getState()?.isPlaying).toBe(true);
    });

    it('should merge a partial patch into existing state', () => {
        dispatchSync({ isPlaying: false, isPaused: false, rate: 1.0 });
        
        // Hydrate voices via decoupled command
        dispatchVoices([], ['VoiceA']);
        store.patchState({ selectedVoice: 'VoiceA', engineMode: 'neural' });

        expect(store.getState()?.availableVoices?.neural).toEqual(['VoiceA']);
        expect(store.getState()?.selectedVoice).toBe('VoiceA');
        // Un-patched fields are preserved
        expect(store.getState()?.isPlaying).toBe(false);
        expect(store.getState()?.rate).toBe(1.0);
    });

    it('should notify subscribers whose selected slice changed', () => {
        dispatchSync({ isPlaying: false });
        dispatchVoices([], []);

        const listener = vi.fn();
        store.subscribe((s) => s.availableVoices?.neural, listener);
        vi.clearAllMocks(); // ignore immediate call on subscribe

        dispatchVoices([], ['ShinyVoice']);

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
