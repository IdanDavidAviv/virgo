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
            isNeuralViable: vi.fn().mockReturnValue(true),
            emit: vi.fn(),
            on: vi.fn()
        } as any;

        const sequenceManager = new SequenceManager();
        const mockSettingsManager = {
            loadVoiceHistory: vi.fn(),
            saveVoiceHistory: vi.fn(),
            addRecentVoice: vi.fn(),
            removeRecentVoice: vi.fn()
        } as any;
        audioBridge = new AudioBridge(stateStore, docController, playbackEngine, sequenceManager, logger, mockSettingsManager);
    });

    it('should fallback to SAPI when neural synthesis times out', async () => {
        const options: PlaybackOptions = { voice: 'NeuralVoice', rate: 0, volume: 50, mode: 'neural' };
        
        // 1. Setup failure
        const timeoutError = new Error('Synthesis Timeout (4s)');
        vi.mocked(playbackEngine.speakNeural).mockRejectedValue(timeoutError);
        
        // 2. Setup spies/listeners
        const speakLocalSpy = vi.spyOn(audioBridge as any, '_speakLocal').mockImplementation(() => {});

        // 3. Start playback / request synthesis
        const cacheKey = 'neural-test-key';
        await audioBridge.synthesize(cacheKey, options);
        
        // 4. Verify results
        expect(speakLocalSpy).toHaveBeenCalled();
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Premium synthesis failed terminal'));
    });
});
