import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { PlaybackEngine } from '@core/playbackEngine';
import { UISyncPacket, IncomingCommand, SnippetHistory, WindowSentence } from '../../common/types';

export class DashboardRelay {
    private _view?: vscode.WebviewView;
    // [Hygiene] Voice scan idempotency — only emit if the voice list has changed since last broadcast.
    private _lastVoiceHash: string = '';

    constructor(
        private readonly _stateStore: StateStore,
        private readonly _docController: DocumentLoadController,
        private readonly _playbackEngine: PlaybackEngine,
        private readonly _logger: (msg: string) => void
    ) {}

    public setView(view: vscode.WebviewView | undefined) {
        if (this._view && this._view !== view) {
            this._logger(`[DashboardRelay] 🔄 Replacing existing view. Cleaving old connection.`);
        }
        this._view = view;
        if (view) {
            this._logger(`[DashboardRelay] 🔌 New view attached.`);
        }
    }

    public clearView() {
        if (this._view) {
            this._logger(`[DashboardRelay] 🏳️ Connection severed.`);
            this._view = undefined;
        }
    }

    /**
     * The single source of truth for the dashboard's state.
     * Aggregates StateStore, DocController, and logic into one packet.
     */
    public sync(snippetHistory?: SnippetHistory, activeSessionId?: string, voices?: { local: any[], neural: any[] }) {
        if (!this._view) { return; }

        const s = this._stateStore.state;
        
        // [INTEGRITY] Validation Guard: Check for undefined properties that should be numeric/objects
        const missingFields: string[] = [];
        if (s.currentChapterIndex === undefined) {missingFields.push('currentChapterIndex');}
        if (s.currentSentenceIndex === undefined) {missingFields.push('currentSentenceIndex');}
        if (s.volume === undefined) {missingFields.push('volume');}
        
        if (missingFields.length > 0) {
            this._logger(`[DashboardRelay] ⚠️ WARNING: StateStore has undefined fields: ${missingFields.join(', ')}. Applying emergency fallback.`);
        }

        const chapters = this._docController.chapters || [];
        const currentChapterIndex = s.currentChapterIndex ?? 0;
        const currentSentenceIndex = s.currentSentenceIndex ?? 0;



        const currentChapter = (currentChapterIndex >= 0 && currentChapterIndex < chapters.length) 
            ? chapters[currentChapterIndex] 
            : null;

        const cacheStats = this._playbackEngine.getCacheStats() || { count: 0, sizeBytes: 0 };
        const config = vscode.workspace.getConfiguration('readAloud');
        const logLevel = config.get<string>('logging.level', 'Standard') === 'Verbose' ? 2 : 1;

        const packet: UISyncPacket = {
            // FOCUSED (Passive Selection)
            focusedFileName: s.focusedFileName || 'No Selection',
            focusedRelativeDir: s.focusedRelativeDir || '',
            focusedDocumentUri: s.focusedDocumentUri?.toString() || null,
            focusedIsSupported: !!s.focusedIsSupported,
            focusedVersionSalt: s.focusedVersionSalt,

            // ACTIVE (Loaded Reader)
            activeFileName: s.activeFileName || 'No File Loaded',
            activeRelativeDir: s.activeRelativeDir || '',
            activeDocumentUri: s.activeDocumentUri?.toString() || null,
            versionSalt: s.versionSalt,

            // Playback Progress
            currentChapterIndex,
            currentSentenceIndex,
            
            // UI Flags
            isRefreshing: !!s.isRefreshing,
            isPreviewing: !!s.isPreviewing,
            activeMode: s.activeMode || 'FILE',
            isLooping: !!s.isLooping,

            // [SOVEREIGNTY] Active Playback Configuration
            isPlaying: !!s.isPlaying,
            isPaused: !!s.isPaused,
            playbackStalled: !!s.playbackStalled,
            volume: s.volume ?? 50,
            rate: s.rate ?? 1.0,
            engineMode: s.engineMode || 'local',
            autoPlayMode: s.autoPlayMode || 'auto',
            selectedVoice: s.selectedVoice,

            // Data Windows
            currentSentences: currentChapter ? currentChapter.sentences : [],
            allChapters: chapters.map((c, i) => ({
                title: c.title || `Chapter ${i+1}`,
                level: c.level ?? 0,
                index: i,
                count: c.sentences ? c.sentences.length : 0
            })),
            
            // Integrity & Cache
            cacheCount: cacheStats.count ?? 0,
            cacheSizeBytes: cacheStats.sizeBytes ?? 0,
            isHydrated: !!s.isHydrated,
            playbackIntentId: s.playbackIntentId || 1,
            batchIntentId: s.batchIntentId || 1,
            lastLoadType: s.lastLoadType || 'none',
            activeSessionId: activeSessionId,
            logLevel: logLevel,
            availableVoices: voices || s.availableVoices,
            windowSentences: this._calculateWindowSentences(currentChapterIndex, currentSentenceIndex)
        };

        this._logger(`[RELAY] 📦 Assembled Packet: active=${packet.activeFileName}, focus=${packet.focusedFileName}, chapters=${packet.allChapters.length}, sets=${packet.currentSentences.length}, hydrated=${packet.isHydrated}, intent=${packet.playbackIntentId}`);
        
        this.postMessage({ command: IncomingCommand.UI_SYNC, ...packet });
    }

    /**
     * Sends a message to the webview.
     * CRITICAL: Whitelist playback commands to pass through even if hidden (to support background play).
     */
    public postMessage(message: any) {
        if (!this._view) { return; }

        const criticalCommands: string[] = [
            IncomingCommand.UI_SYNC, 
            IncomingCommand.PLAY_AUDIO, 
            IncomingCommand.PURGE_MEMORY, 
            IncomingCommand.SYNTHESIS_ERROR, 
            IncomingCommand.STOP, 
            IncomingCommand.PLAYBACK_STATE_CHANGED,
            IncomingCommand.DATA_PUSH,
            IncomingCommand.CLEAR_CACHE_WIPE,
            IncomingCommand.CACHE_STATS_UPDATE,
            IncomingCommand.SPEAK_LOCAL,
            IncomingCommand.VOICES,
            IncomingCommand.ENGINE_STATUS
        ];
        const isCritical = criticalCommands.includes(message.command);

        if (this._view.visible || isCritical) {
            const result = this._view.webview.postMessage(message);
            if (!result) {
                this._logger(`[RELAY] ❌ postMessage returned FALSE for command: ${message.command}`);
            }
        } else {
            this._logger(`[RELAY] 🚫 postMessage BLOCKED (Hidden & Non-Critical): ${message.command}`);
        }
    }

    public broadcastVoices(local: any[], neural: any[], engineMode: string) {
        // [Hygiene] Idempotency guard — skip broadcast if voice list is unchanged.
        const hash = neural.map((v: any) => v.id || v.shortName || v.Name || '').join(',');
        if (hash === this._lastVoiceHash) {
            return;
        }
        this._lastVoiceHash = hash;
        this.postMessage({
            command: 'voices',
            voices: local,
            neuralVoices: neural,
            engineMode: engineMode,
            playbackIntentId: this._stateStore.state.playbackIntentId
        });
    }

    public broadcastEngineStatus(status: string) {
        this.postMessage({
            command: 'engineStatus',
            status: status,
            playbackIntentId: this._stateStore.state.playbackIntentId
        });
    }

    /**
     * Calculates a sliding window of 100 sentences (25 previous, 75 future)
     * across chapter boundaries for predictive synthesis.
     */
    private _calculateWindowSentences(currC: number, currS: number): WindowSentence[] {
        const chapters = this._docController.chapters;
        if (!chapters || chapters.length === 0) { return []; }

        const window: WindowSentence[] = [];
        const BACK_LIMIT = 25;
        const FUTURE_LIMIT = 75;

        // 1. Backtrack 25 sentences
        let bC = currC;
        let bS = currS - 1;
        let bCount = 0;

        while (bCount < BACK_LIMIT && bC >= 0) {
            if (bS < 0) {
                bC--;
                if (bC >= 0) {
                    bS = chapters[bC].sentences.length - 1;
                }
                continue;
            }
            window.unshift({
                text: chapters[bC].sentences[bS],
                cIdx: bC,
                sIdx: bS
            });
            bS--;
            bCount++;
        }

        // 2. Add current
        if (currC >= 0 && currC < chapters.length && currS < chapters[currC].sentences.length) {
            window.push({
                text: chapters[currC].sentences[currS],
                cIdx: currC,
                sIdx: currS
            });
        }

        // 3. Lookahead 74 sentences (total 75 including current)
        let fC = currC;
        let fS = currS + 1;
        let fCount = 0;

        while (fCount < (FUTURE_LIMIT - 1) && fC < chapters.length) {
            if (fS >= chapters[fC].sentences.length) {
                fC++;
                fS = 0;
                continue;
            }
            window.push({
                text: chapters[fC].sentences[fS],
                cIdx: fC,
                sIdx: fS
            });
            fS++;
            fCount++;
        }

        return window;
    }
}
