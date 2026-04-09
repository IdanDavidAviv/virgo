/**
 * audioBridge.bridge.test.ts
 *
 * TDD tests for:
 *  - Law 7.1: FETCH_FAILED Fallback Guard (no redundant synthesis on Tier-2 disk hit)
 *  - Law 7.2: SYNTHESIS_STARTING Deduplication Guard (one emission per cacheKey::intentId)
 *
 * Observed: 2026-04-10. Ref: autoplay_orchestration skill §7.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioBridge } from '@core/audioBridge';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { PlaybackEngine, PlaybackOptions } from '@core/playbackEngine';
import { SequenceManager } from '@core/sequenceManager';

// Mock vscode
vi.mock('vscode', () => ({
    window: {
        activeTextEditor: undefined,
        tabGroups: { activeTabGroup: { activeTab: undefined } }
    },
    workspace: { getWorkspaceFolder: vi.fn(), openTextDocument: vi.fn() },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) }
}));

describe('AudioBridge — Bridge Integrity Laws', () => {
    let audioBridge: AudioBridge;
    let stateStore: StateStore;
    let docController: DocumentLoadController;
    let playbackEngine: PlaybackEngine;
    const logger = vi.fn();
    const options: PlaybackOptions = { voice: 'NeuralVoice', rate: 1, volume: 80, mode: 'neural' };

    beforeEach(() => {
        vi.useFakeTimers();
        stateStore = new StateStore(logger);
        docController = new DocumentLoadController(logger);

        vi.spyOn(docController, 'chapters', 'get').mockReturnValue([
            {
                title: 'Chapter 1',
                sentences: ['Hello world.', 'Second sentence.'],
                level: 1, lineStart: 0, lineEnd: 10, text: 'Hello world. Second sentence.', id: 'ch1'
            } as any
        ]);
        vi.spyOn(docController, 'metadata', 'get').mockReturnValue({
            fileName: 'test.md',
            relativeDir: '.',
            uri: { toString: () => 'test.md' },
            versionSalt: '1'
        } as any);

        playbackEngine = new PlaybackEngine(logger);
        vi.spyOn(playbackEngine, 'isPlaying', 'get').mockReturnValue(true);
        vi.spyOn(playbackEngine, 'isNeuralViable').mockReturnValue(true);
        vi.spyOn(playbackEngine, 'getCached').mockReturnValue(null);
        vi.spyOn(playbackEngine, 'speakNeural').mockResolvedValue('blob');
        vi.spyOn(playbackEngine, 'triggerPrefetch').mockImplementation(() => {});
        vi.spyOn(playbackEngine, 'stop').mockImplementation(() => {});

        const sequenceManager = new SequenceManager();
        audioBridge = new AudioBridge(stateStore, docController, playbackEngine, sequenceManager, logger);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
        audioBridge.removeAllListeners();
    });

    // ─── Law 7.1 ─────────────────────────────────────────────────────────────

    describe('Law 7.1 — FETCH_FAILED Fallback Guard', () => {

        it('should NOT call speakNeural (synthesize) when synthesize() is called within 200ms of a cache confirmation for the same key', async () => {
            const KEY = 'b75b89db-cached-key';

            // Simulate webview confirming disk-cache for this key
            audioBridge.notifyCacheConfirmation(KEY);

            const speakNeuralSpy = vi.spyOn(playbackEngine, 'speakNeural');
            const playAudioSpy = vi.fn();
            audioBridge.on('playAudio', playAudioSpy);

            // Call synthesize — simulating a FETCH_FAILED fallback trigger
            await audioBridge.synthesize(KEY, options);

            // ASSERT: synthesis must NOT have fired — cache confirmation exists within 200ms
            expect(speakNeuralSpy).not.toHaveBeenCalled();

            // ASSERT: playAudio MUST be emitted with the cache key (disk-play path)
            expect(playAudioSpy).toHaveBeenCalledWith(
                expect.objectContaining({ cacheKey: KEY })
            );
        });

        it('should call speakNeural when synthesize() is called with NO prior cache confirmation', async () => {
            const KEY = 'b75b89db-fresh-key';

            const speakNeuralSpy = vi.spyOn(playbackEngine, 'speakNeural');

            await audioBridge.synthesize(KEY, options);

            // No cache confirmation — real miss — synthesis must fire
            expect(speakNeuralSpy).toHaveBeenCalled();
        });

        it('should treat a cache confirmation older than 200ms as expired — synthesis MUST proceed', async () => {
            const KEY = 'b75b89db-expired-key';

            audioBridge.notifyCacheConfirmation(KEY);

            // Advance time beyond the 200ms window
            vi.advanceTimersByTime(201);

            const speakNeuralSpy = vi.spyOn(playbackEngine, 'speakNeural');
            await audioBridge.synthesize(KEY, options);

            // Window expired — must synthesize
            expect(speakNeuralSpy).toHaveBeenCalled();
        });
    });

    // ─── Law 7.3 ─────────────────────────────────────────────────────────────

    describe('Law 7.3 — playAudio Single Emission Guarantee (cache-miss path)', () => {
        it('cache-miss: start() should emit synthesisReady but NOT playAudio', async () => {
            // Enforce: no data in either cache
            vi.spyOn(playbackEngine, 'getCached').mockReturnValue(null);
            (audioBridge as any)._webviewCacheManifest = new Set();

            const playAudioSpy = vi.fn();
            const synthesisReadySpy = vi.fn();
            audioBridge.on('playAudio', playAudioSpy);
            audioBridge.on('synthesisReady', synthesisReadySpy);

            // start() is async but _speakNeural is mocked — we await the microtask queue
            await audioBridge.start(0, 0, options);

            // synthesisReady MUST fire to initiate the pull handshake
            expect(synthesisReadySpy).toHaveBeenCalledTimes(1);

            // playAudio must NOT be emitted by start() itself — only by _speakNeural on completion
            // (speakNeural is mocked to return 'blob', which triggers its own playAudio path)
            const startCallsOnly = playAudioSpy.mock.calls.filter(
                ([payload]) => payload?.data === ''
            );
            expect(startCallsOnly).toHaveLength(0);
        });
    });

    // ─── Law 7.2 ─────────────────────────────────────────────────────────────

    describe('Law 7.2 — SYNTHESIS_STARTING Deduplication Guard', () => {
        it('should emit synthesisStarting exactly once per cacheKey + intentId pair', () => {
            const synthStartingSpy = vi.fn();
            audioBridge.on('synthesisStarting', synthStartingSpy);

            const INTENT = 42;
            vi.spyOn(playbackEngine, 'playbackIntentId', 'get').mockReturnValue(INTENT);

            // Simulate the bridge emitting the event twice for the same pair
            audioBridge.emitSynthesisStarting('key-abc', INTENT);
            audioBridge.emitSynthesisStarting('key-abc', INTENT); // Duplicate — must be suppressed

            expect(synthStartingSpy).toHaveBeenCalledTimes(1);
        });

        it('should allow synthesisStarting for the same cacheKey on a DIFFERENT intentId', () => {
            const synthStartingSpy = vi.fn();
            audioBridge.on('synthesisStarting', synthStartingSpy);

            audioBridge.emitSynthesisStarting('key-abc', 10);
            audioBridge.emitSynthesisStarting('key-abc', 11); // Different intent — must pass through

            expect(synthStartingSpy).toHaveBeenCalledTimes(2);
        });

        it('should clear the dedup set when intent is incremented', () => {
            const synthStartingSpy = vi.fn();
            audioBridge.on('synthesisStarting', synthStartingSpy);

            audioBridge.emitSynthesisStarting('key-abc', 10);
            audioBridge.emitSynthesisStarting('key-abc', 10); // Suppressed

            // Simulate intent increment (e.g. user clicks play again)
            audioBridge.clearSynthesisStartingDedup();

            audioBridge.emitSynthesisStarting('key-abc', 10); // After clear — must pass

            expect(synthStartingSpy).toHaveBeenCalledTimes(2); // First + post-clear
        });
    });
});
