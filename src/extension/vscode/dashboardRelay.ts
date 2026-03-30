import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { PlaybackEngine } from '@core/playbackEngine';
import { UISyncPacket, StateStoreState } from '../../common/types';

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
    public sync(
        autoPlayMode: 'auto' | 'chapter' | 'row', 
        engineMode: 'local' | 'neural',
        selectedVoice: string | undefined,
        rate: number,
        volume: number,
        localVoices: any[],
        neuralVoices: any[]
    ) {
        if (!this._view) { return; }

        const state: StateStoreState = {
            focusedFileName: this._stateStore.state.focusedFileName,
            focusedRelativeDir: this._stateStore.state.focusedRelativeDir,
            focusedDocumentUri: this._stateStore.state.focusedDocumentUri?.toString() || null,
            focusedIsSupported: this._stateStore.state.focusedIsSupported,
            focusedVersionSalt: this._stateStore.state.focusedVersionSalt,

            activeFileName: this._stateStore.state.activeFileName,
            activeRelativeDir: this._stateStore.state.activeRelativeDir,
            activeDocumentUri: this._stateStore.state.activeDocumentUri?.toString() || null,
            versionSalt: this._stateStore.state.versionSalt,

            currentChapterIndex: this._stateStore.state.currentChapterIndex,
            currentSentenceIndex: this._stateStore.state.currentSentenceIndex,
            isRefreshing: this._stateStore.state.isRefreshing,
            isPreviewing: this._stateStore.state.isPreviewing
        };

        const chapters = this._docController.chapters;
        const currentChapterIndex = state.currentChapterIndex;
        const currentSentenceIndex = state.currentSentenceIndex;

        const currentChapter = (currentChapterIndex >= 0 && currentChapterIndex < chapters.length) 
            ? chapters[currentChapterIndex] 
            : null;

        const cacheStats = this._playbackEngine.getCacheStats();

        const packet: UISyncPacket = {
            state,
            isPlaying: this._playbackEngine.isPlaying,
            isPaused: this._playbackEngine.isPaused,
            playbackStalled: this._playbackEngine.isStalled,
            currentSentences: currentChapter ? currentChapter.sentences : [],
            currentText: currentChapter ? currentChapter.sentences[currentSentenceIndex] || "" : "",
            totalChapters: chapters.length,
            allChapters: chapters.map((c, i) => ({
                title: c.title,
                level: c.level,
                index: i,
                count: c.sentences.length
            })),
            availableVoices: {
                local: localVoices,
                neural: neuralVoices
            },
            canPrevChapter: currentChapterIndex > 0,
            canNextChapter: currentChapterIndex < chapters.length - 1,
            canPrevSentence: currentSentenceIndex > 0,
            canNextSentence: (currentChapter && currentSentenceIndex < currentChapter.sentences.length - 1) || false,
            autoPlayMode,
            engineMode,
            cacheCount: cacheStats.count,
            cacheSizeBytes: cacheStats.sizeBytes,
            selectedVoice,
            rate,
            volume
        };

        this.postMessage({ command: 'UI_SYNC', ...packet });
    }

    public postMessage(message: any) {
        if (this._view && this._view.visible) {
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
