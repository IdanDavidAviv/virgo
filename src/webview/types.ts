/**
 * Types and Enums for the Webview (Dashboard)
 */

export enum IncomingCommand {
    UI_SYNC = 'UI_SYNC',
    PLAY_AUDIO = 'playAudio',
    PAUSE_AUDIO = 'pauseAudio',
    RESUME_AUDIO = 'resumeAudio',
    VOICES = 'voices',
    CHAPTERS = 'chapters',
    PROGRESS = 'progress',
    STALLED = 'stalled',
    ERROR = 'error'
}

export enum OutgoingAction {
    READY = 'ready',
    JUMP_TO_SENTENCE = 'jumpToSentence',
    JUMP_TO_CHAPTER = 'jumpToChapter',
    VOICE_CHANGED = 'voiceChanged',
    RATE_CHANGED = 'rateChanged',
    VOLUME_CHANGED = 'volumeChanged',
    REQUEST_SYNTHESIS = 'REQUEST_SYNTHESIS',
    SENTENCE_ENDED = 'sentenceEnded',
    NEXT_SENTENCE = 'nextSentence',
    PREV_SENTENCE = 'prevSentence',
    NEXT_CHAPTER = 'nextChapter',
    PREV_CHAPTER = 'prevChapter',
    AUTO_PLAY_MODE = 'setAutoPlayMode',
    ENGINE_MODE_CHANGED = 'engineModeChanged',
    OPEN_FILE = 'OPEN_FILE',
    LOAD_DOCUMENT = 'loadDocument',
    RESET_CONTEXT = 'resetContext',
    LOG = 'log'
}

export interface Voice {
    Name: string;
    ShortName: string;
    Locale: string;
    Gender: string;
}

export interface Chapter {
    id: string;
    title: string;
    level: number;
    index: number;
}

export interface Sentence {
    text: string;
    index: number;
}

export interface AppState {
    isPlaying: boolean;
    isPaused: boolean;
    playbackStalled: boolean;
    currentChapterIndex: number;
    currentSentenceIndex: number;
    totalChapters: number;
    totalSentences: number;
    currentVolume: number;
    currentRate: number;
    currentVoice?: string;
    availableVoices: Voice[];
    allChapters: Chapter[];
    currentSentences: Sentence[];
    activeUri?: string;
    activeFileName?: string;
    autoPlay: boolean;
    engineMode: 'cloud' | 'local';
}
