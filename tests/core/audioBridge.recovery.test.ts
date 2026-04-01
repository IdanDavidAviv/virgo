import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('AudioBridge Recovery', () => {
    let audioBridge: AudioBridge;
    let stateStore: StateStore;
    let docController: DocumentLoadController;
    let playbackEngine: PlaybackEngine;
    const logger = vi.fn();

    beforeEach(() => {
        stateStore = new StateStore(logger);
        docController = new DocumentLoadController(logger);
        
        vi.spyOn(docController, 'chapters', 'get').mockReturnValue([
            { title: 'Chapter 1', sentences: ['Sentence 1'], level: 1, lineStart: 0, lineEnd: 1, text: 'text 1', id: '1' } as any,
        ]);
        vi.spyOn(docController, 'metadata', 'get').mockReturnValue({ 
            fileName: 'test.md', 
            relativeDir: '.', 
            uri: { toString: () => 'test.md' }, 
            versionSalt: '123' 
        } as any);

        // CREATE A ROBUST MOCK
        playbackEngine = {
            isPlaying: true,
            isPaused: false,
            isStalled: false,
            setPlaying: vi.fn(),
            setPaused: vi.fn(),
            stop: vi.fn(),
            speakNeural: vi.fn(),
            speakLocal: vi.fn(),
            triggerPrefetch: vi.fn(),
            emit: vi.fn(),
            on: vi.fn()
        } as any;

        const sequenceManager = new SequenceManager();
        audioBridge = new AudioBridge(stateStore, docController, playbackEngine, sequenceManager, logger);
    });

    it('should emit buffering status and NOT fallback to SAPI when neural synthesis times out', async () => {
        const options: PlaybackOptions = { voice: 'NeuralVoice', rate: 0, volume: 50, mode: 'neural' };
        
        // 1. Setup failure
        const timeoutError = new Error('Synthesis Timeout (4s)');
        vi.mocked(playbackEngine.speakNeural).mockRejectedValue(timeoutError);
        
        // 2. Setup spies/listeners
        const synthesisErrorSpy = vi.fn();
        const engineStatusSpy = vi.fn();
        audioBridge.on('synthesisError', synthesisErrorSpy);
        audioBridge.on('engineStatus', engineStatusSpy);

        // 3. Start playback / request synthesis
        const recoveryWait = new Promise<void>((resolve) => {
            audioBridge.once('synthesisError', () => resolve());
        });

        // Use synthesize directly as it's the entry point for actual synthesis work
        const cacheKey = 'neural-test-key';
        audioBridge.synthesize(cacheKey, options);
        
        // 4. Await results
        await recoveryWait;
        await Promise.resolve();

        // 5. Verify results
        expect(synthesisErrorSpy).toHaveBeenCalledWith(expect.objectContaining({
            error: 'Synthesis Timeout (4s)',
            isFallingBack: false
        }));
        expect(engineStatusSpy).toHaveBeenCalledWith({ status: 'buffering' });
        expect(playbackEngine.speakLocal).not.toHaveBeenCalled();
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Neural synthesis stalled'));
    });
});
