import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { SnippetHistory } from '../../common/types';

/**
 * Single Source of Truth for the extension and dashboard.
 * Separates FOCUSED (Passive Selection) and ACTIVE (Loaded Reader) states.
 */
export interface StateMetadata {
    // FOCUSED (Status of the current VS Code editor selection)
    focusedFileName: string;
    focusedRelativeDir: string;
    focusedDocumentUri: vscode.Uri | undefined;
    focusedIsSupported: boolean;
    focusedVersionSalt?: string;

    // ACTIVE (Reader Context - what is currently being read)
    activeFileName: string;
    activeRelativeDir: string;
    activeDocumentUri: vscode.Uri | undefined;
    versionSalt?: string; // e.g. V1, V2 metadata for badges
    activeContentHash?: string; // Hidden internal fingerprint for persistence [RESOLVE 25]

    // Playback Progress
    currentSentenceIndex: number;
    currentChapterIndex: number;
    
    // Playback Status [ISSUE 17]
    isPlaying: boolean;
    isPaused: boolean;
    playbackStalled: boolean;

    // Engine & Options [ISSUE 17]
    engineMode: 'local' | 'neural';
    autoPlayMode: 'auto' | 'chapter' | 'row';
    selectedVoice?: string;
    availableVoices: { local: any[], neural: any[] };
    rate: number;
    volume: number;

    // UI Flags
    isPreviewing: boolean;
    isRefreshing: boolean;
    lastLoadType: 'cache' | 'synth' | 'none';
    activeMode: 'FILE' | 'SNIPPET';
    isLooping: boolean;
    autoPlayOnInjection: boolean;
    isSelectingVoice: boolean; // [v2.4.0] Sampling mode for voice changes

    // Cache Stats [ISSUE 26]
    cacheCount: number;
    cacheSizeBytes: number;

    // Agent Governance
    autoInjectSITREP: boolean;
    playbackIntentId: number;
    batchIntentId: number;
    isHydrated: boolean;
    playbackAuthorized: boolean; // [COLD-BOOT GATE] True only after an explicit user play gesture.

    // Antigravity Context (Session Persistence)
    snippetHistory: SnippetHistory;
    activeSessionId?: string;
}

export class StateStore extends EventEmitter {
    private _state: StateMetadata;

    constructor(private readonly _logger: (msg: string) => void) {
        super();
        this._state = this._getInitialState();
    }

    private _getInitialState(): StateMetadata {
        return {
            focusedFileName: 'No Selection',
            focusedRelativeDir: '',
            focusedDocumentUri: undefined,
            focusedIsSupported: false,
            
            activeFileName: 'No File Loaded',
            activeRelativeDir: '',
            activeDocumentUri: undefined,
            
            currentSentenceIndex: 0,
            currentChapterIndex: 0,

            isPlaying: false,
            isPaused: false,
            playbackStalled: false,

            engineMode: 'local',
            autoPlayMode: 'auto',
            availableVoices: { local: [], neural: [] },
            rate: 1.0,
            volume: 50,

            isPreviewing: false,
            isRefreshing: false,
            lastLoadType: 'none',
            activeMode: 'FILE',
            isLooping: false,
            autoPlayOnInjection: false,
            cacheCount: 0,
            cacheSizeBytes: 0,
            snippetHistory: [],
            activeSessionId: undefined,
            autoInjectSITREP: true,
            playbackIntentId: 1,
            batchIntentId: 1,
            isHydrated: false,
            isSelectingVoice: false,
            playbackAuthorized: false
        };
    }

    public get state(): Readonly<StateMetadata> {
        return this._state;
    }

    /**
     * Updates the passive selection (Focused File).
     */
    public setFocusedFile(uri: vscode.Uri | undefined, fileName: string, relativeDir: string, isSupported: boolean, versionSalt?: string, silent: boolean = false) {
        this._state.focusedDocumentUri = uri;
        this._state.focusedFileName = fileName || 'No Selection';
        this._state.focusedRelativeDir = relativeDir;
        this._state.focusedIsSupported = isSupported;
        this._state.focusedVersionSalt = versionSalt;
        this._logger(`[STATE] focused_updated: ${this._state.focusedFileName} | salt: ${versionSalt}`);
        if (!silent) {
            this.emit('change', this.state);
        }
    }

    /**
     * Updates the active reader context (Loaded File) atomically.
     */
    public setActiveDocument(
        uri: vscode.Uri | undefined, 
        fileName: string, 
        relativeDir: string, 
        versionSalt?: string,
        contentHash?: string,
        initialProgress?: { chapterIndex: number, sentenceIndex: number } | null,
        silent: boolean = false
    ) {
        this._state.activeDocumentUri = uri;
        this._state.activeFileName = fileName || 'No File Loaded';
        this._state.activeRelativeDir = relativeDir;
        this._state.versionSalt = versionSalt;
        this._state.activeContentHash = contentHash;

        // Atomic Reset/Restore [ISSUE 25]
        this._state.currentChapterIndex = initialProgress?.chapterIndex ?? 0;
        this._state.currentSentenceIndex = initialProgress?.sentenceIndex ?? 0;

        // Status Reset
        this._state.isPlaying = false;
        this._state.isPaused = false;

        this._logger(`[STATE] active_document_updated (atomic): ${this._state.activeFileName} @ ${this._state.currentChapterIndex}:${this._state.currentSentenceIndex}`);
        if (!silent) {
            this.emit('change', this.state);
        }
    }

    /**
     * Updates the current reading position.
     */
    public setProgress(chapterIndex: number, sentenceIndex: number, silent: boolean = false) {
        this._state.currentChapterIndex = chapterIndex;
        this._state.currentSentenceIndex = sentenceIndex;
        if (!silent) {
            this.emit('change', this.state);
        }
    }

    /**
     * Updates playback status flags. [ISSUE 17]
     */
    public setPlaybackStatus(isPlaying: boolean, isPaused: boolean, playbackStalled: boolean = false, silent: boolean = false) {
        this._state.isPlaying = isPlaying;
        this._state.isPaused = isPaused;
        this._state.playbackStalled = playbackStalled;
        if (!silent) {
            this.emit('change', this.state);
        }
    }

    /**
     * Updates the last load type for the webview.
     */
    public setLoadType(type: 'cache' | 'synth' | 'none') {
        this._state.lastLoadType = type;
        this.emit('change', this.state);
    }

    /**
     * Updates the snippet history for the dashboard.
     */
    public setHistory(history: SnippetHistory) {
        this._state.snippetHistory = history;
        this.emit('change', this.state);
    }

    /**
     * Updates the active session ID.
     */
    public setSessionId(id: string) {
        this._state.activeSessionId = id;
        this.emit('change', this.state);
    }

    public setOptions(options: { 
        engineMode?: 'local' | 'neural', 
        autoPlayMode?: 'auto' | 'chapter' | 'row',
        selectedVoice?: string,
        rate?: number,
        volume?: number,
        autoPlayOnInjection?: boolean,
        autoInjectSITREP?: boolean
    }) {
        if (options.engineMode) { this._state.engineMode = options.engineMode; }
        if (options.autoPlayMode) { this._state.autoPlayMode = options.autoPlayMode; }
        if (options.selectedVoice !== undefined) { this._state.selectedVoice = options.selectedVoice; }
        if (options.rate !== undefined) { this._state.rate = options.rate; }
        if (options.volume !== undefined) { this._state.volume = options.volume; }
        if (options.autoPlayOnInjection !== undefined) { this._state.autoPlayOnInjection = options.autoPlayOnInjection; }
        if (options.autoInjectSITREP !== undefined) { this._state.autoInjectSITREP = options.autoInjectSITREP; }
        this.emit('change', this.state);
    }

    /**
     * Updates available voices. [ISSUE 17]
     */
    public setVoices(local: any[], neural: any[]) {
        this._state.availableVoices = { local, neural };
        this.emit('change', this.state);
    }

    /**
     * Sets the previewing flag.
     */
    public setPreviewing(value: boolean) {
        this._state.isPreviewing = value;
        this.emit('change', this.state);
    }

    /**
     * Sets the refreshing flag.
     */
    public setRefreshing(value: boolean) {
        this._state.isRefreshing = value;
        this.emit('change', this.state);
    }

    /**
     * Sets the active UI mode (FILE vs SNIPPET).
     */
    public setActiveMode(mode: 'FILE' | 'SNIPPET', silent: boolean = false) {
        this._state.activeMode = mode;
        this._logger(`[STATE] active_mode_updated: ${mode}`);
        if (!silent) {
            this.emit('change', this.state);
        }
    }

    /**
     * Sets the looping flag.
     */
    public setLooping(value: boolean) {
        this._state.isLooping = value;
        this.emit('change', this.state);
    }

    /**
     * Clears only the active reader context, preserving the background "focused" file state. [ISSUE 21]
     */
    public clearActiveContext() {
        this._state.activeFileName = 'No File Loaded';
        this._state.activeRelativeDir = '';
        this._state.activeDocumentUri = undefined;
        this._state.currentChapterIndex = 0;
        this._state.currentSentenceIndex = 0;
        this._state.isPlaying = false;
        this._state.isPaused = false;
        this._state.playbackStalled = false;
        this._state.versionSalt = '';
        this._state.activeContentHash = '';

        this._logger('[STATE] active_context_cleared');
        this.emit('change', this.state);
    }

    /**
     * Atomically resets all selection and playback state.
     */
    public reset() {
        const savedOptions = {
            engineMode: this._state.engineMode,
            autoPlayMode: this._state.autoPlayMode,
            selectedVoice: this._state.selectedVoice,
            rate: this._state.rate,
            volume: this._state.volume
        };
        this._state = { ...this._getInitialState(), ...savedOptions };
        this._logger('[STATE] full_reset_complete');
        this.emit('change', this.state);
    }

    /**
     * Updates the global playback intent ID with magnitude protection.
     * Rejects any ID that is less than the current state to prevent stale synchronization.
     */
    public setPlaybackIntentId(id: number) {
        if (id <= this._state.playbackIntentId) {
            if (id < this._state.playbackIntentId) {
                this._logger(`[STATE] playback_intent_rejected: ${id} < ${this._state.playbackIntentId}`);
            }
            return;
        }
        this._state.playbackIntentId = id;
        this._logger(`[STATE] playback_intent_latched: ${id}`);
        this.emit('change', this.state);
    }

    /**
     * Atomically increments the playback intent ID.
     */
    public incrementPlaybackIntent(): number {
        const nextId = this._state.playbackIntentId + 1;
        this.setPlaybackIntentId(nextId);
        return nextId;
    }

    /**
     * Updates the global batch intent ID with magnitude protection.
     */
    public setBatchIntentId(id: number) {
        if (id <= this._state.batchIntentId) {
            if (id < this._state.batchIntentId) {
                this._logger(`[STATE] batch_intent_rejected: ${id} < ${this._state.batchIntentId}`);
            }
            return;
        }
        this._state.batchIntentId = id;
        this._logger(`[STATE] batch_intent_latched: ${id}`);
        this.emit('change', this.state);
    }

    /**
     * Atomically increments the batch intent ID.
     */
    public incrementBatchIntent(): number {
        const nextId = this._state.batchIntentId + 1;
        this.setBatchIntentId(nextId);
        return nextId;
    }

    /**
     * [v2.0.7] Partial state update with automatic notification.
     * @param patch The state fragment to merge.
     * @param silent If true, suppresses the 'change' event (useful for bulk initialization).
     */
    public patchState(patch: Partial<StateMetadata>, silent: boolean = false) {
        this._state = { ...this._state, ...patch };
        if (!silent) {
            this.emit('change', this.state);
        }
    }
}
