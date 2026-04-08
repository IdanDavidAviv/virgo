import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioBridge } from '@core/audioBridge';
import { PlaybackEngine } from '@core/playbackEngine';
import { DocumentLoadController } from '@core/documentLoadController';
import { StateStore } from '@core/stateStore';
import { SequenceManager } from '@core/sequenceManager';
import { parseChapters } from '@core/documentParser';
import { EventEmitter } from 'events';

// --- STUB MODULES ---
vi.mock('vscode', () => ({
    Uri: {
        file: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }),
        parse: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }),
        joinPath: vi.fn((uri, ...parts) => ({ fsPath: parts.join('/') }))
    },
    workspace: {
        getWorkspaceFolder: vi.fn(),
        getConfiguration: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(true)
        })
    },
    window: {
        activeTextEditor: undefined,
        tabGroups: { activeTabGroup: { activeTab: undefined } }
    }
}));

vi.mock('msedge-tts', () => {
    const { EventEmitter } = require('events');
    return {
        MsEdgeTTS: class {
            toStream = vi.fn().mockReturnValue({ audioStream: new EventEmitter() });
            setMetadata = vi.fn().mockResolvedValue(undefined);
        },
        OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' }
    };
});

vi.mock('child_process', () => {
    const { EventEmitter } = require('events');
    return {
        spawn: vi.fn().mockReturnValue(new EventEmitter())
    };
});

describe('Voice Stability Integration (Marathon)', () => {
    let engine: PlaybackEngine;
    let bridge: AudioBridge;
    let docController: DocumentLoadController;
    let stateStore: StateStore;
    let sequenceManager: SequenceManager;
    let logger: any;

    const MOCK_MD = `
# Chapter 1
Sentence 1.
Sentence 2.
Sentence 3.

# Chapter 2
Sentence 4 with code.
\`\`\`ts
const x = 1;
\`\`\`

# Chapter 3
S5.
S6.
S7.
S8.
S9.

# Chapter 4
S10.

# Chapter 5
S11.
S12.
`;

    beforeEach(() => {
        vi.useFakeTimers();
        logger = vi.fn();
        stateStore = new StateStore(logger);
        engine = new PlaybackEngine(logger);
        docController = new DocumentLoadController(logger);
        sequenceManager = new SequenceManager();
        bridge = new AudioBridge(stateStore, docController, engine, sequenceManager, logger);

        // Load the mock document
        const chapters = parseChapters(MOCK_MD);
        (docController as any)._chapters = chapters;
    });

    const defaultOptions = { voice: 'V', rate: 1, volume: 50, mode: 'neural' } as any;

    it('should maintain intent sovereignty throughout a 5-chapter marathon', async () => {
        const speakSpy = vi.spyOn(engine, 'speakNeural').mockResolvedValue('mock-audio-base64');

        // 1. Initial Start
        await bridge.start(0, 0, defaultOptions); 
        const initialIntent = engine.playbackIntentId;
        expect(initialIntent).toBeGreaterThan(0);

        const chapters = docController.chapters;
        let sentencesToPlay: { cIdx: number, sIdx: number, text: string }[] = [];
        
        chapters.forEach((ch, cIdx) => {
            ch.sentences.forEach((s, sIdx) => {
                sentencesToPlay.push({ cIdx, sIdx, text: s });
            });
        });

        // 2. Play through all sentences in "Auto Mode"
        for (let i = 0; i < sentencesToPlay.length; i++) {
            const current = sentencesToPlay[i];
            
            // Simulation of Webview reaction to Coordinate Change/SynthesisReady
            // In the real app, the webview calls synthesize() when it needs the data
            await bridge.synthesize(`cache-key-${i}`, defaultOptions, initialIntent);

            // Assert engine received the correct intent and text
            expect(speakSpy).toHaveBeenLastCalledWith(
                current.text,
                expect.anything(),
                expect.anything(),
                true, // priority
                initialIntent,
                expect.anything() // batchId
            );

            // Simulate Audio Completion -> Webview calls bridge.next('auto')
            if (i < sentencesToPlay.length - 1) {
                await bridge.next(defaultOptions, false, 'auto');
            }
        }

        // 3. Final verification
        expect(stateStore.state.currentChapterIndex).toBe(4); // Last chapter
        expect(stateStore.state.currentSentenceIndex).toBe(2); // Last sentence of Ch5 (S12)
        
        // Throughout the whole document, the intentId never drifted or reset
        speakSpy.mock.calls.forEach(call => {
            expect(call[4]).toBe(initialIntent); // 5th argument is intentId
        });

        // Ensure we hit exactly 18 sentences (Headings + Prose + Code Blocks)
        expect(speakSpy).toHaveBeenCalledTimes(18);
    });

    it('should REJECT synthesis if bridge intent is reverted (Safety Check)', async () => {
        const speakSpy = vi.spyOn(engine, 'speakNeural');
        
        await bridge.start(0, 0, defaultOptions);
        const intent1 = engine.playbackIntentId;

        // Manually corrupt the engine intent (simulating a race or bug)
        (engine as any)._playbackIntentId = 999; 

        // This should fail or be ignored by the engine's internal checks
        const result = await (bridge as any)._speakNeural('Hidden', 'k', {}, 0, 0, intent1, 0);
        
        // The engine's speakNeural now checks intent vs _playbackIntentId
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('EJECTED'));
    });
});
