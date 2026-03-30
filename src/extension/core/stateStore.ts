import * as vscode from 'vscode';
import { EventEmitter } from 'events';

export interface StateMetadata {
    activeFileName: string;
    activeRelativeDir: string;
    activeDocumentUri: vscode.Uri | undefined;
    currentSentenceIndex: number;
    currentChapterIndex: number;
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
            activeFileName: 'No Selection',
            activeRelativeDir: '',
            activeDocumentUri: undefined,
            currentSentenceIndex: 0,
            currentChapterIndex: 0,
            isPreviewing: false,
            isRefreshing: false
        };
    }

    public get state(): Readonly<StateMetadata> {
        return this._state;
    }

    /**
     * Updates the active document selection.
     */
    public setSelection(uri: vscode.Uri | undefined, fileName: string, relativeDir: string) {
        this._state.activeDocumentUri = uri;
        this._state.activeFileName = fileName;
        this._state.activeRelativeDir = relativeDir;
        this._logger(`[STATE] selection_updated: ${fileName}`);
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
