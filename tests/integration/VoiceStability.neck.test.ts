import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioBridge } from '@core/audioBridge';
import { PlaybackEngine } from '@core/playbackEngine';
import { DocumentLoadController } from '@core/documentLoadController';
import { StateStore } from '@core/stateStore';
import { SequenceManager } from '@core/sequenceManager';
import { parseChapters } from '@core/documentParser';
import { EventEmitter } from 'events';

// --- STUBS ---
vi.mock('vscode', () => ({
    Uri: {
        file: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }),
        parse: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }),
        joinPath: vi.fn((uri, ...parts) => ({ fsPath: parts.join('/') }))
    },
    workspace: {
        getWorkspaceFolder: vi.fn(),
        getConfiguration: vi.fn().mockReturnValue({
            get: vi.fn((key: string) => {
                if (key === 'virgo.playback.rate') {return 0;}
                if (key === 'virgo.playback.volume') {return 50;}
                return true;
            })
        })
    },
    window: {
        activeTextEditor: undefined,
        tabGroups: { activeTabGroup: { activeTab: undefined } }
    }
}));

vi.mock('msedge-tts', () => {
    return {
        MsEdgeTTS: class {
            toStream = vi.fn().mockReturnValue({ audioStream: new EventEmitter() });
            setMetadata = vi.fn().mockResolvedValue(undefined);
        },
        OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' }
    };
});

describe('Voice Stability (Neck) - Intent 0 Repair', () => {
    let engine: PlaybackEngine;
    let bridge: AudioBridge;
    let docController: DocumentLoadController;
    let stateStore: StateStore;
    let sequenceManager: SequenceManager;
    let logger: any;

    const MOCK_MD = `# Chapter 1\nSentence 1.`;

    beforeEach(() => {
        logger = vi.fn();
        stateStore = new StateStore(logger);
        engine = new PlaybackEngine(stateStore, logger);
        docController = new DocumentLoadController(logger);
        sequenceManager = new SequenceManager();
        bridge = new AudioBridge(stateStore, docController, engine, sequenceManager, logger);

        const chapters = parseChapters(MOCK_MD);
        (docController as any)._chapters = chapters;
    });

    const defaultOptions = { voice: 'V', rate: 1, volume: 50, mode: 'neural' } as any;

    it('should REPAIR the protocol when Webview sends Intent 0 during initial handshake', async () => {
        const speakSpy = vi.spyOn(engine, 'speakNeural').mockResolvedValue('mock-audio');

        // 1. Extension starts playback (New Intent generated)
        await bridge.start(0, 0, defaultOptions);
        const engineIntent = engine.playbackIntentId;
        expect(engineIntent).toBeGreaterThan(0);

        // 2. Webview, still uninitialized or race-condition, sends synthesize with Intent 0
        // This is exactly the bug where 0 mismatch causes rejection.
        await bridge.synthesize('cache-key-1', defaultOptions, 0);

        // 3. Assert [PROTOCOL_REPAIR] logic kicked in and used engineIntent
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('[PROTOCOL_REPAIR]'));
        
        // 4. Verify engine actually received the adopted intent, NOT 0
        expect(speakSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            true, 
            engineIntent, // Crucial: It adopted the extension's intent
            expect.anything()
        );
    });
});
