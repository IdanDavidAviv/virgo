import * as vscode from 'vscode';
import * as path from 'path';
import { StateStore } from '@core/stateStore';

export interface PersistentState {
    uri?: string;
    fileName?: string;
    chapterIndex?: number;
    sentenceIndex?: number;
    options?: {
        engineMode?: 'local' | 'neural';
        voice?: string;
        rate?: number;
        volume?: number;
        autoPlayMode?: 'auto' | 'chapter' | 'row';
    };
}

export class PersistenceManager {
    private static readonly KEY = 'read-aloud.active-context';

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _stateStore: StateStore,
        private readonly _logger: (msg: string) => void
    ) { }

    /**
     * Rehydrates the StateStore from VS Code persistence.
     */
    public hydrate() {
        const saved = this._context.workspaceState.get<PersistentState>(PersistenceManager.KEY);
        if (!saved) {
            this._logger('[PERSISTENCE] No saved context found.');
            return;
        }

        this._logger(`[PERSISTENCE] Rehydrating context: ${saved.fileName} (${saved.chapterIndex}:${saved.sentenceIndex})`);

        // Hydrate StateStore (Silent update to prevent change-event loops during init)
        this._stateStore.patchState({
            currentChapterIndex: saved.chapterIndex ?? 0,
            currentSentenceIndex: saved.sentenceIndex ?? 0,
            engineMode: saved.options?.engineMode ?? 'local',
            selectedVoice: saved.options?.voice ?? '',
            rate: saved.options?.rate ?? 1.5,
            volume: saved.options?.volume ?? 1,
            autoPlayMode: saved.options?.autoPlayMode ?? 'auto'
        });

        // If there's a URI, we also set the active document (which triggers loading in docController)
        if (saved.uri) {
            try {
                const uri = vscode.Uri.parse(saved.uri);
                // Note: We don't call setActiveDocument directly here because we want to 
                // maintain the hydrated progress. SpeechProvider will handle the loading logic.
                this._stateStore.patchState({
                    activeDocumentUri: uri,
                    activeFileName: saved.fileName || 'Unknown'
                });
            } catch (e) {
                this._logger(`[PERSISTENCE_ERR] Failed to parse saved URI: ${e}`);
            }
        }
    }

    /**
     * Persists critical StateStore fields to VS Code storage.
     */
    public persist() {
        const state = this._stateStore.state;

        // Only persist if we have a real file
        if (!state.activeDocumentUri) {
            return;
        }

        const data: PersistentState = {
            uri: state.activeDocumentUri.toString(),
            fileName: path.basename(state.activeDocumentUri.fsPath),
            chapterIndex: state.currentChapterIndex,
            sentenceIndex: state.currentSentenceIndex,
            options: {
                engineMode: state.engineMode,
                voice: state.selectedVoice,
                rate: state.rate,
                volume: state.volume,
                autoPlayMode: state.autoPlayMode
            }
        };

        this._context.workspaceState.update(PersistenceManager.KEY, data);
        this._logger(`[PERSISTENCE] Context saved: ${data.fileName} at ${data.chapterIndex}:${data.sentenceIndex}`);
    }

    /**
     * Subscribes to StateStore changes to auto-persist.
     */
    public watch() {
        // [PERFORMANCE] Debounce persistence to avoid excessive I/O during playback progress updates
        let timer: NodeJS.Timeout | undefined;
        this._stateStore.on('change', () => {
            if (timer) { clearTimeout(timer); }
            timer = setTimeout(() => this.persist(), 2000); // Persist every 2 seconds of change
        });
    }
}
