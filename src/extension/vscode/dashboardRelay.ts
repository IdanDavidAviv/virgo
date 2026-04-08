import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { PlaybackEngine } from '@core/playbackEngine';
import { UISyncPacket, StateStoreState, IncomingCommand, SnippetHistory, WindowSentence } from '../../common/types';

export class DashboardRelay {
    private _view?: vscode.WebviewView;

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
        
        // Map StateStoreState for the packet (Matches src/common/types.ts)
        const state: StateStoreState = {
            focusedFileName: s.focusedFileName,
            focusedRelativeDir: s.focusedRelativeDir,
            focusedDocumentUri: s.focusedDocumentUri?.toString() || null,
            focusedIsSupported: s.focusedIsSupported,
            focusedVersionSalt: s.focusedVersionSalt,

            activeFileName: s.activeFileName,
            activeRelativeDir: s.activeRelativeDir,
            activeDocumentUri: s.activeDocumentUri?.toString() || null,
            versionSalt: s.versionSalt,

            currentChapterIndex: s.currentChapterIndex,
            currentSentenceIndex: s.currentSentenceIndex,
            isRefreshing: s.isRefreshing,
            isPreviewing: s.isPreviewing,
            activeMode: s.activeMode
        };

        const chapters = this._docController.chapters;
        const currentChapterIndex = state.currentChapterIndex;
        const currentSentenceIndex = state.currentSentenceIndex;

        const currentChapter = (currentChapterIndex >= 0 && currentChapterIndex < chapters.length) 
            ? chapters[currentChapterIndex] 
            : null;

        const cacheStats = this._playbackEngine.getCacheStats();
        const config = vscode.workspace.getConfiguration('readAloud');
        const logLevel = config.get<string>('logging.level', 'Standard') === 'Verbose' ? 2 : 1;

        const packet: UISyncPacket = {
            state,
            isPlaying: s.isPlaying,
            isPaused: s.isPaused,
            playbackStalled: s.playbackStalled,
            currentSentences: currentChapter ? currentChapter.sentences : [],
            currentText: currentChapter ? currentChapter.sentences[currentSentenceIndex] || "" : "",
            totalChapters: chapters.length,
            allChapters: chapters.map((c, i) => ({
                title: c.title,
                level: c.level,
                index: i,
                count: c.sentences.length
            })),
            canPrevChapter: currentChapterIndex > 0,
            canNextChapter: currentChapterIndex < chapters.length - 1,
            canPrevSentence: currentSentenceIndex > 0,
            canNextSentence: (currentChapter && currentSentenceIndex < currentChapter.sentences.length - 1) || false,
            autoPlayMode: s.autoPlayMode,
            engineMode: s.engineMode,
            cacheCount: cacheStats.count,
            cacheSizeBytes: cacheStats.sizeBytes,
            playbackIntentId: s.playbackIntentId,
            selectedVoice: s.selectedVoice,
            rate: s.rate,
            volume: s.volume,
            lastLoadType: s.lastLoadType,
            activeMode: state.activeMode,
            logLevel: logLevel,
            currentChapterIndex: currentChapterIndex,
            isLooping: s.isLooping,
            snippetHistory: snippetHistory,
            activeSessionId: activeSessionId,
            availableVoices: voices,
            batchIntentId: s.batchIntentId,
            windowSentences: this._calculateWindowSentences(currentChapterIndex, currentSentenceIndex)
        };

        this.postMessage({ command: 'UI_SYNC', ...packet });
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
            IncomingCommand.SPEAK_LOCAL
        ];
        const isCritical = criticalCommands.includes(message.command);

        if (this._view.visible || isCritical) {
            this._view.webview.postMessage(message);
        }
    }

    public broadcastVoices(local: any[], neural: any[], engineMode: string) {
        this.postMessage({
            command: 'voices',
            voices: local,
            neuralVoices: neural,
            engineMode: engineMode
        });
    }

    public broadcastEngineStatus(status: string) {
        this.postMessage({
            command: 'engineStatus',
            status: status
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
