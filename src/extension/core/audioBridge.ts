import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { PlaybackEngine, PlaybackOptions } from '@core/playbackEngine';
import { EventEmitter } from 'events';

export interface AudioBridgeEvents {
    'sentenceChanged': (payload: { text: string, chapterIndex: number, sentenceIndex: number, totalSentences: number, sentences: string[], suppressButtonToggle?: boolean }) => void;
    'chapterChanged': (payload: { index: number, total: number, totalSentences: number, title: string }) => void;
    'playAudio': (payload: { data: string, text: string, chapterIndex: number, sentenceIndex: number, totalSentences: number, sentences: string[] }) => void;
    'synthesisError': (payload: { error: string, isFallingBack: boolean }) => void;
    'engineStatus': (payload: { status: string }) => void;
    'playbackFinished': () => void;
}

export class AudioBridge extends EventEmitter {
    constructor(
        private readonly _stateStore: StateStore,
        private readonly _docController: DocumentLoadController,
        private readonly _playbackEngine: PlaybackEngine,
        private readonly _logger: (msg: string) => void
    ) {
        super();
    }

    public on<K extends keyof AudioBridgeEvents>(event: K, listener: AudioBridgeEvents[K]): this {
        return super.on(event, listener);
    }

    public emit<K extends keyof AudioBridgeEvents>(event: K, ...args: Parameters<AudioBridgeEvents[K]>): boolean {
        return super.emit(event, ...args);
    }

    /**
     * Start playing a specific chapter and sentence.
     */
    public async start(chapterIndex: number, sentenceIndex: number, options: PlaybackOptions, previewOnly: boolean = false) {
        // CRITICAL: Stop any in-flight synthesis or sequences before starting a new one.
        // This ensures that jumps immediately abort previous tasks and clear the lock.
        this._playbackEngine.stop();

        const chapters = this._docController.chapters;
        if (chapterIndex < 0 || chapterIndex >= chapters.length) {
            this._logger(`[BRIDGE] Invalid chapter index: ${chapterIndex}`);
            return;
        }

        const chapter = chapters[chapterIndex];
        if (!chapter.sentences || chapter.sentences.length === 0) {
            this._logger(`[BRIDGE] Chapter ${chapterIndex} has no sentences. Skipping.`);
            this.next(options);
            return;
        }

        if (sentenceIndex < 0 || sentenceIndex >= chapter.sentences.length) {
            this._logger(`[BRIDGE] Invalid sentence index: ${sentenceIndex}. Setting to 0.`);
            sentenceIndex = 0;
        }

        this._stateStore.setProgress(chapterIndex, sentenceIndex);
        this._stateStore.setPreviewing(previewOnly);

        if (sentenceIndex === 0) {
            this.emit('chapterChanged', {
                index: chapterIndex,
                total: chapters.length,
                totalSentences: chapter.sentences.length,
                title: chapter.title
            });
        }

        const sentence = chapter.sentences[sentenceIndex];
        const cacheKey = this._getCacheKey(chapterIndex, sentenceIndex, options.voice);

        this.emit('sentenceChanged', {
            text: sentence,
            chapterIndex,
            sentenceIndex,
            totalSentences: chapter.sentences.length,
            sentences: chapter.sentences
        });

        if (options.mode === 'neural') {
            await this._speakNeural(sentence, cacheKey, options, chapterIndex, sentenceIndex);
            
            if (!this._stateStore.state.isPreviewing) {
                this._triggerPreFetch(chapterIndex, sentenceIndex + 1, options);
            }
        } else {
            this._speakLocal(sentence, options);
        }
    }

    public stop() {
        this._playbackEngine.stop();
        this._stateStore.setProgress(0, 0);
        this._logger('[BRIDGE] Playback stopped.');
    }

    public pause() {
        this._playbackEngine.setPaused(true);
        this._logger('[BRIDGE] Playback paused.');
    }

    public next(options: PlaybackOptions, manual: boolean = false, autoPlayMode: 'auto' | 'chapter' | 'row' = 'auto') {
        if (this._stateStore.state.isPreviewing) {
            this._stateStore.setPreviewing(false);
            this._logger(`[BRIDGE] Preview finished. Waiting for user Play.`);
            return;
        }

        if (manual || autoPlayMode === 'auto') {
            this._advanceNormally(options);
        } else if (autoPlayMode === 'row') {
            this.stop();
        } else if (autoPlayMode === 'chapter') {
            const chapter = this._docController.chapters[this._stateStore.state.currentChapterIndex];
            if (this._stateStore.state.currentSentenceIndex + 1 < chapter.sentences.length) {
                this.start(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex + 1, options);
            } else {
                this.stop();
            }
        }
    }

    public previous(options: PlaybackOptions) {
        const chapters = this._docController.chapters;
        if (this._stateStore.state.currentSentenceIndex > 0) {
            this.start(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex - 1, options);
        } else if (this._stateStore.state.currentChapterIndex > 0) {
            const prevChapterIdx = this._stateStore.state.currentChapterIndex - 1;
            const prevChapter = chapters[prevChapterIdx];
            this.start(prevChapterIdx, prevChapter.sentences.length - 1, options);
        }
    }

    private _advanceNormally(options: PlaybackOptions) {
        const chapters = this._docController.chapters;
        const chapter = chapters[this._stateStore.state.currentChapterIndex];
        
        if (this._stateStore.state.currentSentenceIndex + 1 < chapter.sentences.length) {
            this.start(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex + 1, options);
        } else if (this._stateStore.state.currentChapterIndex + 1 < chapters.length) {
            this.start(this._stateStore.state.currentChapterIndex + 1, 0, options);
        } else {
            this._logger('[BRIDGE] End of document reached.');
            this.emit('playbackFinished');
        }
    }

    private async _speakNeural(sentence: string, cacheKey: string, options: PlaybackOptions, cIdx: number, sIdx: number) {
        try {
            const data = await this._playbackEngine.speakNeural(sentence, cacheKey, options);
            
            // GUARD: Ensure the state hasn't changed while we were awaiting synthesis.
            // If the user jumped again, cIdx/sIdx will no longer match the current state.
            const state = this._stateStore.state;
            if (state.currentChapterIndex !== cIdx || state.currentSentenceIndex !== sIdx) {
                this._logger(`[BRIDGE] Ignoring stale synthesis result for ${cIdx}:${sIdx}`);
                return;
            }

            if (data && (this._playbackEngine.isPlaying || state.isPreviewing)) {
                this.emit('playAudio', {
                    data,
                    text: sentence,
                    chapterIndex: cIdx,
                    sentenceIndex: sIdx,
                    totalSentences: this._docController.chapters[cIdx].sentences.length,
                    sentences: this._docController.chapters[cIdx].sentences
                });
            }
        } catch (err: any) {
            const errorMessage = err?.message || String(err);
            if (errorMessage.includes('Abort') || errorMessage.includes('Cancel')) {
                this._logger(`[BRIDGE] Neural synthesis cancelled: ${errorMessage}`);
                return;
            }

            if (!this._playbackEngine.isPlaying) {
                this._logger('[BRIDGE] Synthesis failed, but engine is stopped.');
                return;
            }

            this._logger(`[BRIDGE] Neural synthesis failed: ${errorMessage}. Falling back to SAPI.`);
            this.emit('synthesisError', { error: errorMessage, isFallingBack: true });
            this.emit('engineStatus', { status: 'local-fallback' });
            this._speakLocal(sentence, options);
        }
    }

    private _speakLocal(sentence: string, options: PlaybackOptions) {
        this._playbackEngine.speakLocal(sentence, options, (code) => {
            if (code === 0 && !this._playbackEngine.isPaused && this._playbackEngine.isPlaying) {
                this.next(options);
            }
        });
    }

    private _triggerPreFetch(chapterIndex: number, sentenceIndex: number, options: PlaybackOptions) {
        if (!this._playbackEngine.isPlaying || this._stateStore.state.isPreviewing) {
            return;
        }

        // DEBOUNCE & LIMIT PREFETCH (Prevents queue bloat during rapid clicking)
        setTimeout(() => {
            // Re-check if still playing and still on the same chapter/sentence
            // This kills "stale" prefetch triggers from skipped sentences
            if (!this._playbackEngine.isPlaying || 
                this._stateStore.state.currentChapterIndex !== chapterIndex || 
                (this._stateStore.state.currentSentenceIndex + 1) !== sentenceIndex) {
                return;
            }

            let count = 0;
            let cIdx = chapterIndex;
            let sIdx = sentenceIndex;

            // Limit depth to 3 for better agility
            while (count < 3) {
                const chapter = this._docController.chapters[cIdx];
                if (!chapter) { break; }

                if (sIdx < chapter.sentences.length) {
                    const text = chapter.sentences[sIdx];
                    const cacheKey = this._getCacheKey(cIdx, sIdx, options.voice);
                    this._playbackEngine.triggerPrefetch(text, cacheKey, options);
                    sIdx++;
                    count++;
                } else {
                    cIdx++;
                    sIdx = 0;
                }
            }
        }, 300);
    }

    private _getCacheKey(chapterIndex: number, sentenceIndex: number, voice: string): string {
        const metadata = this._docController.metadata;
        const docId = metadata.uri?.toString() || metadata.fileName;
        const saltStr = metadata.versionSalt ? `-${metadata.versionSalt}` : '';
        return `${voice}-${docId}${saltStr}-${chapterIndex}-${sentenceIndex}`;
    }
}
