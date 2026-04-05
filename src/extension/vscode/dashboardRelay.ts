import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { PlaybackEngine } from '@core/playbackEngine';
import { UISyncPacket, StateStoreState, IncomingCommand, SnippetHistory } from '../../common/types';

export class DashboardRelay {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _stateStore: StateStore,
        private readonly _docController: DocumentLoadController,
        private readonly _playbackEngine: PlaybackEngine,
        private readonly _logger: (msg: string) => void
    ) {}

    public setView(view: vscode.WebviewView | undefined) {
        this._view = view;
    }

    /**
     * The single source of truth for the dashboard's state.
     * Aggregates StateStore, DocController, and logic into one packet.
     */
    public sync(snippetHistory?: SnippetHistory, activeSessionId?: string) {
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
            selectedVoice: s.selectedVoice,
            rate: s.rate,
            volume: s.volume,
            lastLoadType: s.lastLoadType,
            activeMode: state.activeMode,
            logLevel: logLevel,
            currentChapterIndex: currentChapterIndex,
            isLooping: s.isLooping,
            snippetHistory: snippetHistory,
            activeSessionId: activeSessionId
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
            IncomingCommand.CACHE_STATS_UPDATE
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
}
