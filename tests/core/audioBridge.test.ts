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

        playbackEngine = new PlaybackEngine(logger);
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

    it('should update StateStore progress and emit playAudio with empty data on start (Zero-IPC)', async () => {
        const playAudioSpy = vi.fn();
        audioBridge.on('playAudio', playAudioSpy);
        vi.spyOn(playbackEngine, 'getCached').mockReturnValue(null);

        await audioBridge.start(0, 0, options);

        expect(stateStore.state.currentChapterIndex).toBe(0);
        expect(stateStore.state.currentSentenceIndex).toBe(0);
        expect(playAudioSpy).toHaveBeenCalledWith(expect.objectContaining({
            cacheKey: expect.stringMatching(/neuralvoice/i),
            data: '',
            sentenceIndex: 0,
            sentences: expect.any(Array),
            totalSentences: 2
        }));
        expect(playbackEngine.speakNeural).not.toHaveBeenCalled();
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
        expect(readySpy).toHaveBeenCalled();
    });

    it('should call speakNeural and emit playAudio with binary data when synthesize() is called', async () => {
        const playAudioSpy = vi.fn();
        const readySpy = vi.fn();
        audioBridge.on('playAudio', playAudioSpy);
        audioBridge.on('synthesisReady', readySpy);
        vi.spyOn(playbackEngine, 'speakNeural').mockResolvedValue('fresh-blob');
        vi.spyOn(playbackEngine, 'playbackIntentId', 'get').mockReturnValue(456);

        // Act
        const synthPromise = audioBridge.synthesize('some-key', options);
        
        // Manual trigger of the event that would normally be emitted by playbackEngine.speakNeural
        playbackEngine.emit('synthesis-complete', { cacheKey: 'some-key', data: 'fresh-blob', intentId: 456 });
        
        await synthPromise;

        expect(playbackEngine.speakNeural).toHaveBeenCalled();
        expect(playAudioSpy).toHaveBeenCalledWith(expect.objectContaining({
            cacheKey: 'some-key',
            data: 'fresh-blob' // Restored Push
        }));
        expect(readySpy).toHaveBeenCalledWith(expect.objectContaining({
            cacheKey: 'some-key',
            intentId: 456
        }));
    });

    it('should advance to next sentence indices on next() but not call speakNeural', async () => {
        await audioBridge.start(0, 0, options);
        audioBridge.next(options, true);

        expect(stateStore.state.currentSentenceIndex).toBe(1);
        expect(playbackEngine.speakNeural).not.toHaveBeenCalled();
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

    it('should ignore stale synthesis results during rapid sentence jumps', async () => {
        const playAudioSpy = vi.fn();
        audioBridge.on('playAudio', playAudioSpy);

        // Mock a slow synthesis for the first call
        let firstResolve: any;
        const firstPromise = new Promise(resolve => firstResolve = resolve);
        vi.spyOn(playbackEngine, 'speakNeural').mockReturnValueOnce(firstPromise as any);
        
        // Ensure playbackEngine.stop is tracked
        const stopSpy = vi.spyOn(playbackEngine, 'stop');

        // 1. Initial Start (Zero-IPC) -> _activeRequestId = 1
        await audioBridge.start(0, 0, options);
        expect(playAudioSpy).toHaveBeenCalledTimes(1);
        
        // 2. Trigger synthesis for the first sentence -> Enters _speakNeural with requestId=1
        const synthPromise = audioBridge.synthesize('key-0', options);

        // 3. Rapid Jump while synthesis is pending -> _activeRequestId = 2
        await audioBridge.start(0, 1, options);
        expect(playAudioSpy).toHaveBeenCalledTimes(2);

        // 4. Finish the (now stale) synthesis for requestId=1
        firstResolve('base64_stale');
        await synthPromise;

        expect(stopSpy).toHaveBeenCalled();
        
        // VERIFY: playAudio should have been called twice (both with empty data for Zero-IPC starts), 
        // but the 'base64_stale' data should have been ignored because the requestId (1) 
        // no longer matches the current _activeRequestId (2).
        expect(playAudioSpy).toHaveBeenCalledTimes(2); 
        const sentData = playAudioSpy.mock.calls.map(c => c[0].data);
        expect(sentData).not.toContain('base64_stale');
        expect(sentData.every((d: string) => d === '')).toBe(true);
    });
});
