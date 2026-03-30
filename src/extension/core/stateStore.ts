import * as vscode from 'vscode';
import { EventEmitter } from 'events';

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
            volume: 1.0,

            isPreviewing: false,
            isRefreshing: false
        };
    }

    public get state(): Readonly<StateMetadata> {
        return this._state;
    }

    /**
     * Updates the passive selection (Focused File).
     */
    public setFocusedFile(uri: vscode.Uri | undefined, fileName: string, relativeDir: string, isSupported: boolean, versionSalt?: string) {
        this._state.focusedDocumentUri = uri;
        this._state.focusedFileName = fileName || 'No Selection';
        this._state.focusedRelativeDir = relativeDir;
        this._state.focusedIsSupported = isSupported;
        this._state.focusedVersionSalt = versionSalt;
        this._logger(`[STATE] focused_updated: ${this._state.focusedFileName} | salt: ${versionSalt}`);
        this.emit('change', this.state);
    }

    /**
     * Updates the active reader context (Loaded File).
     */
    public setActiveDocument(uri: vscode.Uri | undefined, fileName: string, relativeDir: string, versionSalt?: string) {
        this._state.activeDocumentUri = uri;
        this._state.activeFileName = fileName || 'No File Loaded';
        this._state.activeRelativeDir = relativeDir;
        this._state.versionSalt = versionSalt;
        this._logger(`[STATE] active_document_updated: ${this._state.activeFileName}`);
        this.emit('change', this.state);
    }

    /**
     * Updates the current reading position.
     */
    public setProgress(chapterIndex: number, sentenceIndex: number) {
        this._state.currentChapterIndex = chapterIndex;
        this._state.currentSentenceIndex = sentenceIndex;
        this.emit('change', this.state);
    }

    /**
     * Updates playback status flags. [ISSUE 17]
     */
    public setPlaybackStatus(isPlaying: boolean, isPaused: boolean, playbackStalled: boolean = false) {
        this._state.isPlaying = isPlaying;
        this._state.isPaused = isPaused;
        this._state.playbackStalled = playbackStalled;
        this.emit('change', this.state);
    }

    /**
     * Updates engine and user options. [ISSUE 17]
     */
    public setOptions(options: { 
        engineMode?: 'local' | 'neural', 
        autoPlayMode?: 'auto' | 'chapter' | 'row',
        selectedVoice?: string,
        rate?: number,
        volume?: number
    }) {
        if (options.engineMode) { this._state.engineMode = options.engineMode; }
        if (options.autoPlayMode) { this._state.autoPlayMode = options.autoPlayMode; }
        if (options.selectedVoice !== undefined) { this._state.selectedVoice = options.selectedVoice; }
        if (options.rate !== undefined) { this._state.rate = options.rate; }
        if (options.volume !== undefined) { this._state.volume = options.volume; }
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
     * Atomically resets all selection and playback state.
     */
    public reset() {
        this._state = this._getInitialState();
        this._logger('[STATE] reset_complete');
        this.emit('change', this.state);
    }
}
