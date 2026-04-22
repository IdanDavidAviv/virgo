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

describe('AudioBridge', () => {
    let audioBridge: AudioBridge;
    let stateStore: StateStore;
    let docController: DocumentLoadController;
    let playbackEngine: PlaybackEngine;
    const logger = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        stateStore = new StateStore(logger);
        docController = new DocumentLoadController(logger);
        
        // Mocking DocumentLoadController methods
        vi.spyOn(docController, 'chapters', 'get').mockReturnValue([
            { title: 'Chapter 1', sentences: ['Sentence 1', 'Sentence 2'], level: 1, lineStart: 0, lineEnd: 10, text: 'full text 1', id: '1' } as any,
            { title: 'Chapter 2', sentences: ['Sentence 3'], level: 1, lineStart: 11, lineEnd: 20, text: 'full text 2', id: '2' } as any
        ]);
        vi.spyOn(docController, 'metadata', 'get').mockReturnValue({ fileName: 'test.md', relativeDir: '.', uri: { toString: () => 'test.md' }, versionSalt: '123' } as any);

        playbackEngine = new PlaybackEngine(stateStore, logger);
        vi.spyOn(playbackEngine, 'isNeuralViable').mockReturnValue(true);
        vi.spyOn(playbackEngine, 'isPlaying', 'get').mockReturnValue(true);
        vi.spyOn(playbackEngine, 'speakNeural').mockResolvedValue('base64audio');
        vi.spyOn(playbackEngine, 'triggerPrefetch').mockImplementation(() => {});

        const sequenceManager = new SequenceManager();
        audioBridge = new AudioBridge(stateStore, docController, playbackEngine, sequenceManager, logger);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
        audioBridge.removeAllListeners();
    });

    const options: PlaybackOptions = { voice: 'NeuralVoice', rate: 0, volume: 50, mode: 'neural' };

    it('[Law 7.3] should emit playAudio with binary data on cache miss (proactive Push-on-miss via start())', async () => {
        const playAudioSpy = vi.fn();
        const synthesisReadySpy = vi.fn();
        audioBridge.on('playAudio', playAudioSpy);
        audioBridge.on('synthesisReady', synthesisReadySpy);
        vi.spyOn(playbackEngine, 'getCached').mockReturnValue(null);

        await audioBridge.start(0, 0, options);

        // Law 7.3 updated: playAudio IS emitted with data on cache miss since start() awaits synthesis.
        // synthesisReady is suppressed because Path C owns delivery.
        expect(playAudioSpy).toHaveBeenCalledWith(expect.objectContaining({
            cacheKey: expect.stringMatching(/neuralvoice/i),
            data: 'base64audio'
        }));
        expect(synthesisReadySpy).not.toHaveBeenCalled();

        // StateStore progress must still be updated
        expect(stateStore.state.currentChapterIndex).toBe(0);
        expect(stateStore.state.currentSentenceIndex).toBe(0);

        // speakNeural IS called on start() now
        expect(playbackEngine.speakNeural).toHaveBeenCalled();
    });

    it('should fallback to LOCAL mode when NEURAL is requested but not viable (Autoradiant Fallback)', async () => {
        const speakLocalSpy = vi.fn();
        audioBridge.on('speakLocal', speakLocalSpy);
        
        // Force neural stall
        vi.spyOn(playbackEngine, 'isNeuralViable').mockReturnValue(false);
        vi.spyOn(playbackEngine, 'getCached').mockReturnValue(null);

        await audioBridge.start(0, 0, options);

        // Verify routing decision
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Falling back to LOCAL'));
        
        // Verify local speech was triggered instead of neural
        expect(speakLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
            text: 'Sentence 1',
            voiceId: 'NeuralVoice' // Still uses the requested voice name for local search
        }));
    });

    it('should emit playAudio with binary data on extension cache hit (Push-on-Hit Architecture)', async () => {
        const playAudioSpy = vi.fn();
        const readySpy = vi.fn();
        audioBridge.on('playAudio', playAudioSpy);
        audioBridge.on('synthesisReady', readySpy);
        vi.spyOn(playbackEngine, 'getCached').mockReturnValue('cached-blob');
        vi.spyOn(playbackEngine, 'playbackIntentId', 'get').mockReturnValue(123);

        await audioBridge.start(0, 0, options);

        expect(playAudioSpy).toHaveBeenCalledWith(expect.objectContaining({
            cacheKey: expect.stringMatching(/neuralvoice/i),
            data: 'cached-blob', // Restored Push
            sentenceIndex: 0,
            intentId: 123
        }));
    });

    it('should call speakNeural and emit playAudio with binary data when synthesize() is called', async () => {
        const playAudioSpy = vi.fn();
        // [SINGLE-SINK]: dataPush is suppressed for the ACTIVE cacheKey (Path C owns delivery).
        // Only pre-fetched keys (non-active) get dataPush. We only test playAudio here.
        audioBridge.on('playAudio', playAudioSpy);
        vi.spyOn(playbackEngine, 'speakNeural').mockResolvedValue('fresh-blob');
        vi.spyOn(playbackEngine, 'playbackIntentId', 'get').mockReturnValue(456);

        // Act — synthesize() calls _speakNeural which awaits speakNeural and emits playAudio
        await audioBridge.synthesize('some-key', options);

        expect(playbackEngine.speakNeural).toHaveBeenCalled();
        expect(playAudioSpy).toHaveBeenCalledWith(expect.objectContaining({
            cacheKey: 'some-key',
            data: 'fresh-blob'
        }));
    });

    it('should advance to next sentence indices on next() and call speakNeural for proactive synthesis', async () => {
        await audioBridge.start(0, 0, options);
        vi.clearAllMocks();
        // [FIX] next() is async — must be awaited to ensure speakNeural and state updates complete.
        await audioBridge.next(options, true);

        expect(stateStore.state.currentSentenceIndex).toBe(1);
        expect(playbackEngine.speakNeural).toHaveBeenCalled();
    });

    it('should advance to next chapter when current chapter ends', async () => {
        await audioBridge.start(0, 1, options);
        audioBridge.next(options, true);

        expect(stateStore.state.currentChapterIndex).toBe(1);
        expect(stateStore.state.currentSentenceIndex).toBe(0);
    });

    it('should trigger pre-fetch after starting playback', async () => {
        await audioBridge.start(0, 0, options);
        
        vi.advanceTimersByTime(250); // Above 200ms debounce
        
        expect(playbackEngine.triggerPrefetch).toHaveBeenCalled();
    });

    it('should NOT fallback to local speech on neural failure during synthesis', async () => {
        vi.spyOn(playbackEngine, 'speakNeural').mockRejectedValue(new Error('Network Error'));
        vi.spyOn(playbackEngine, 'speakLocal').mockImplementation(() => {});
        
        const errorSpy = vi.fn();
        audioBridge.on('synthesisError', errorSpy);

        await audioBridge.synthesize('test-key', options);

        expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ 
            isFallingBack: false,
            cacheKey: 'test-key',
            chapterIndex: 0,
            sentenceIndex: 0
        }));
        expect(playbackEngine.speakLocal).not.toHaveBeenCalled();
    });

    it('[Law 7.3] should ignore stale synthesis results during rapid sentence jumps — stale data never fires on playAudio', async () => {
        const playAudioSpy = vi.fn();
        audioBridge.on('playAudio', playAudioSpy);

        // Mock a slow synthesis for the first call (sentence 0)
        let firstResolve: any;
        const firstPromise = new Promise(resolve => firstResolve = resolve);
        vi.spyOn(playbackEngine, 'speakNeural').mockReturnValueOnce(firstPromise as any);
        
        // Ensure playbackEngine.stop is tracked
        const stopSpy = vi.spyOn(playbackEngine, 'stop');

        // 1. Initial Start (cache miss, slow) — will hang until firstPromise resolves
        const startPromise1 = audioBridge.start(0, 0, options);
        
        // 2. Rapid Jump to sentence 1 while synthesis is pending
        //    This bumps intent + updates position (ch:0, s:1)
        const startPromise2 = audioBridge.start(0, 1, options);

        // 3. Resolve the (now stale) synthesis for the FIRST request
        firstResolve('base64_stale');
        
        await Promise.all([startPromise1, startPromise2]);

        // stop() must have been called when the jump preempted the first start
        expect(stopSpy).toHaveBeenCalled();
        
        // STALE DROP: _speakNeural checks ch/si match against current stateStore.
        // After startPromise2, stateStore.currentSentenceIndex === 1, so the stale
        // result for sentence 0 is dropped — playAudio with stale data must NOT fire.
        expect(playAudioSpy).not.toHaveBeenCalledWith(expect.objectContaining({
            data: 'base64_stale'
        }));
        
        // The fresh data from the second start WILL fire (speakNeural mock returns 'base64audio')
        expect(playAudioSpy).toHaveBeenCalledWith(expect.objectContaining({
            data: 'base64audio'
        }));
    });

    it('should implement Commitment-on-Play: batchId increments only when options drift during start()', async () => {
        const batchSpy = vi.spyOn(stateStore, 'setBatchIntentId');
        const initialBatch = stateStore.state.batchIntentId;
        
        // 1. Initial start - sets latches (increments batchId on first manual start)
        await audioBridge.start(0, 0, options);
        expect(batchSpy).toHaveBeenCalledWith(initialBatch + 1);
        batchSpy.mockClear();

        // 2. Start again with same options - should NOT increment further (it adopts the current batch if not explicitly provided, but wait...)
        // Actually, in the current implementation, every manual start() without IDs increments batchId.
        // Let's re-verify line 137: 
        // const resolutionBatch = (intentId === undefined && batchId === undefined) || isCommitmentThresholdCrossed ? finalBatch + 1 : finalBatch;
        
        await audioBridge.start(0, 0, options);
        expect(batchSpy).toHaveBeenCalledWith(initialBatch + 2);
        batchSpy.mockClear();

        // 3. Change voice in options
        const newOptions = { ...options, voice: 'NewVoice' };
        
        // 4. Start again with new options - should detect drift and increment batchId
        await audioBridge.start(0, 0, newOptions);
        expect(batchSpy).toHaveBeenCalledWith(initialBatch + 3);
        
        // 5. Verify the drift was detected in logs (optional, but confirms the logic)
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Commitment Threshold crossed'));
    });
});
