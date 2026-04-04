export interface Chapter {
    title: string;
    level: number;
    lineStart: number;
    lineEnd: number;
    text: string;
    originalMarkdown: string;
    sentences: string[];
    sentenceLines: number[];
}

export interface StateStoreState {
    // FOCUSED (Passive Selection)
    focusedFileName: string;
    focusedRelativeDir: string;
    focusedDocumentUri: string | null;
    focusedIsSupported: boolean;
    focusedVersionSalt?: string;

    // ACTIVE (Loaded Reader)
    activeFileName: string;
    activeRelativeDir: string;
    activeDocumentUri: string | null;
    versionSalt?: string;

    // Playback Progress
    currentChapterIndex: number;
    currentSentenceIndex: number;
    
    // UI Flags
    isRefreshing: boolean;
    isPreviewing: boolean;
}

export enum LogLevel {
    STANDARD = 1,
    VERBOSE = 2
}

export interface UISyncPacket {
    state: StateStoreState;
    isPlaying: boolean;
    isPaused: boolean;
    playbackStalled: boolean;
    currentSentences: string[];
    allChapters: { title: string, level: number, index: number, count: number }[]; // [PHASE 4] Full chapter metadata
    currentText: string;
    totalChapters: number;
    canPrevChapter: boolean;
    canNextChapter: boolean;
    canPrevSentence: boolean;
    canNextSentence: boolean;
    autoPlayMode: 'auto' | 'chapter' | 'row';
    engineMode: 'local' | 'neural';
    availableVoices?: { local: any[], neural: any[] }; // [PHASE 4] Full voice lists
    cacheCount: number;
    cacheSizeBytes: number;
    cacheStats?: { count: number, size: number };
    selectedVoice?: string;
    rate: number;
    volume: number;
    neuralVoices?: any[];
    lastLoadType?: 'cache' | 'synth' | 'none';
    logLevel: LogLevel;
}


/**
 * Commands sent FROM Extension TO Webview
 */
export enum IncomingCommand {
    UI_SYNC = 'UI_SYNC',
    PLAY_AUDIO = 'playAudio',
    STOP = 'stop',
    VOICES = 'voices',
    ENGINE_STATUS = 'engineStatus',
    SYNTHESIS_ERROR = 'synthesisError',
    PURGE_MEMORY = 'PURGE_MEMORY',
    PLAYBACK_STATE_CHANGED = 'playbackStateChanged',
    CACHE_STATS = 'cacheStats',
    SENTENCE_CHANGED = 'sentenceChanged',
    PROGRESS = 'progress',
    DATA_PUSH = 'DATA_PUSH',
    SYNTHESIS_STARTING = 'SYNTHESIS_STARTING',
    CLEAR_CACHE_WIPE = 'CLEAR_CACHE_WIPE',
    CACHE_STATS_UPDATE = 'CACHE_STATS_UPDATE'
}


/**
 * Actions sent FROM Webview TO Extension
 */
export enum OutgoingAction {
    READY = 'ready',
    PLAY = 'play',
    PAUSE = 'pause',
    STOP = 'stop',
    CONTINUE = 'continue',
    LOAD_AND_PLAY = 'loadAndPlay',
    JUMP_TO_CHAPTER = 'jumpToChapter',
    JUMP_TO_SENTENCE = 'jumpToSentence',
    PREV_CHAPTER = 'prevChapter',
    NEXT_CHAPTER = 'nextChapter',
    PREV_SENTENCE = 'prevSentence',
    NEXT_SENTENCE = 'nextSentence',
    SET_AUTO_PLAY_MODE = 'setAutoPlayMode',
    SENTENCE_ENDED = 'sentenceEnded',
    ENGINE_MODE_CHANGED = 'engineModeChanged',
    VOICE_CHANGED = 'voiceChanged',
    RATE_CHANGED = 'rateChanged',
    VOLUME_CHANGED = 'volumeChanged',
    RESET_CONTEXT = 'resetContext',
    LOAD_DOCUMENT = 'loadDocument',
    OPEN_FILE = 'OPEN_FILE',
    REQUEST_SYNTHESIS = 'REQUEST_SYNTHESIS',
    CLEAR_CACHE = 'CLEAR_CACHE',
    TOGGLE_PLAY_PAUSE = 'TOGGLE_PLAY_PAUSE',
    LOG = 'log',
    ERROR = 'error'
}
