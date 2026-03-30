import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioBridge } from '@core/audioBridge';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { PlaybackEngine, PlaybackOptions } from '@core/playbackEngine';

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

        audioBridge = new AudioBridge(stateStore, docController, playbackEngine, logger);
    });

    const options: PlaybackOptions = { voice: 'NeuralVoice', rate: 0, volume: 50, mode: 'neural' };

    it('should emit sentenceChanged and call speakNeural on start', async () => {
        const sentenceSpy = vi.fn();
        audioBridge.on('sentenceChanged', sentenceSpy);

        await audioBridge.start(0, 0, options);

        expect(sentenceSpy).toHaveBeenCalledWith(expect.objectContaining({
            text: 'Sentence 1',
            chapterIndex: 0,
            sentenceIndex: 0
        }));
        expect(playbackEngine.speakNeural).toHaveBeenCalled();
    });

    it('should advance to next sentence on next()', async () => {
        await audioBridge.start(0, 0, options);
        audioBridge.next(options, true);

        expect(stateStore.state.currentSentenceIndex).toBe(1);
    });

    it('should advance to next chapter when current chapter ends', async () => {
        await audioBridge.start(0, 1, options);
        audioBridge.next(options, true);

        expect(stateStore.state.currentChapterIndex).toBe(1);
        expect(stateStore.state.currentSentenceIndex).toBe(0);
    });

    it('should trigger pre-fetch after starting playback', async () => {
        await audioBridge.start(0, 0, options);
        
        vi.advanceTimersByTime(300);
        
        expect(playbackEngine.triggerPrefetch).toHaveBeenCalled();
    });

    it('should fallback to local speech on neural failure', async () => {
        vi.spyOn(playbackEngine, 'speakNeural').mockRejectedValue(new Error('Network Error'));
        vi.spyOn(playbackEngine, 'speakLocal').mockImplementation(() => {});
        
        const errorSpy = vi.fn();
        audioBridge.on('synthesisError', errorSpy);

        await audioBridge.start(0, 0, options);

        expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ isFallingBack: true }));
        expect(playbackEngine.speakLocal).toHaveBeenCalled();
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

        // Trigger first jump
        const start1 = audioBridge.start(0, 0, options);
        
        // Immediate second jump while first is pending
        vi.spyOn(playbackEngine, 'speakNeural').mockResolvedValue('base64_2');
        const start2 = audioBridge.start(0, 1, options);

        // Finish first synthesis
        firstResolve('base64_1');
        await Promise.all([start1, start2]);

        // VERIFY: PlaybackEngine.stop should have been called at least once (on second start)
        expect(stopSpy).toHaveBeenCalled();
        
        // VERIFY: playAudio should NOT have been called for the first sentence (stale)
        // It should ONLY have been called for the second sentence.
        expect(playAudioSpy).toHaveBeenCalledTimes(1);
        expect(playAudioSpy).toHaveBeenCalledWith(expect.objectContaining({
            sentenceIndex: 1,
            data: 'base64_2'
        }));
    });
});
