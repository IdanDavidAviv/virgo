import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
            get: vi.fn((key: string) => (key === 'readAloud.playback.rate' ? 0 : 50))
        })
    },
    window: {
        activeTextEditor: undefined,
        tabGroups: { activeTabGroup: { activeTab: undefined } }
    }
}));

vi.mock('msedge-tts', () => ({
    MsEdgeTTS: class {
        toStream() {
            const stream = new EventEmitter() as any;
            process.nextTick(() => stream.emit('end'));
            return { audioStream: stream };
        }
        setMetadata() { return Promise.resolve(); }
        close() { }
    },
    OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' }
}));

import { PlaybackEngine } from '@core/playbackEngine';
import { AudioBridge } from '@core/audioBridge';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
// import { SessionController } from '@webview/sessionController';
import { SequenceManager } from '@core/sequenceManager';
import { parseChapters } from '@core/documentParser';

// --- HELPER ---
function generateMarathonDocument(numChapters: number) {
    let md = "";
    for (let i = 1; i <= numChapters; i++) {
        md += `# Chapter ${i}\n`;
        const rows = Math.floor(Math.random() * 5) + 1;
        for (let r = 1; r <= rows; r++) {
            md += `Row ${r} of Chap ${i}. Neural resilience stress test.\n`;
        }
        md += "\n";
    }
    return md;
}

describe('Neural Resilience Integration - Extension Layer', () => {
    let engine: PlaybackEngine;
    let bridge: AudioBridge;
    let docController: DocumentLoadController;
    let stateStore: StateStore;
    let sequenceManager: SequenceManager;
    let logger: any;

    beforeEach(() => {
        vi.useFakeTimers();
        logger = vi.fn();
        stateStore = new StateStore(logger);
        engine = new PlaybackEngine(stateStore, logger);
        docController = new DocumentLoadController(logger);
        sequenceManager = new SequenceManager();
        bridge = new AudioBridge(stateStore, docController, engine, sequenceManager, logger);

        const chapters = parseChapters(generateMarathonDocument(5));
        (docController as any)._chapters = chapters;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should DETECT MsEdgeTTS "readyState" crash and trigger self-healing re-init', async () => {
        vi.useRealTimers();

        // Ensure readyState is defined initially
        (engine as any)._tts.readyState = 1;

        // Mock a library crash: property becomes undefined or throws
        // [v2.3.1] Fix: Spy on prototype because instances are replaced during re-init
        const MsEdgeTTS = await import('msedge-tts').then(m => m.MsEdgeTTS);
        vi.spyOn(MsEdgeTTS.prototype, 'toStream').mockImplementation(() => {
            throw new TypeError("Cannot read property 'readyState' of undefined");
        });

        // Trigger crash by clearing readyState manually to simulate corruption
        (engine as any)._tts.readyState = undefined;

        console.log('[TEST] Triggering synthesis with simulated library corruption...');
        try {
            await engine.speakNeural(
                "test",
                "en-US-GuyNeural",
                // @ts-ignore
                "50",
                "0-intent-id",
                engine.batchIntentId
            );
        } catch (e: any) {
            console.log(`[TEST] speakNeural caught expected error: ${e.message}`);
        }

        // Verify re-init was called via the logger SSOT
        await vi.waitFor(() => {
            const reinitLogged = logger.mock.calls.some((call: any[]) =>
                typeof call[0] === 'string' &&
                call[0].includes('Authority Re-initialization')
            );
            if (!reinitLogged) {
                // Diagnostic: dump last few logs
                const lastLogs = logger.mock.calls.slice(-3).map((c: any[]) => c[0]);
                throw new Error(`Waiting for reinit log. Last logs: ${JSON.stringify(lastLogs)}`);
            }
        }, { timeout: 10000 });

        console.log('[TEST] ✅ Extension detected crash and signaled failure.');
    }, 30000);

    it('should marathon-run 5 chapters with explicit synthesis requests', async () => {
        // Mock speakNeural to succeed for the marathon
        const speakSpy = vi.spyOn(engine, 'speakNeural').mockResolvedValue('mock-audio-64');

        console.log('[TEST] Starting 5-chapter Marathon with Webview feedback simulation...');

        const options = { mode: 'neural', voice: 'V', rate: 1, volume: 50, playbackIntentId: 'test-intent-id', batchIntentId: 'test-batch-id' } as any;
        await bridge.start(0, 0, options);

        // Simulate progression loop
        for (let i = 0; i < 5; i++) {
            // 1. Simulate Webview requesting synthesis for current sentence
            await bridge.synthesize("mock-cache-key-" + i, options);

            // 2. Simulate Webview finishing playback and moving to next
            await bridge.next(options);
            await vi.advanceTimersByTimeAsync(100);
        }

        expect(speakSpy).toHaveBeenCalled();
        console.log('[TEST] ✅ Marathon logic confirmed.');
    });
});
