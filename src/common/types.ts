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

export interface WindowSentence {
    text: string;
    cIdx: number;
    sIdx: number;
}

export enum LogLevel {
    STANDARD = 1,
    VERBOSE = 2
}

export interface UISyncPacket {
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
    isSelectingVoice: boolean; // [NEW] Sampling mode for voice changes
    activeMode: 'FILE' | 'SNIPPET';
    isLooping: boolean;

    // [SOVEREIGNTY] Active Playback Configuration
    isPlaying: boolean;
    isPaused: boolean;
    playbackStalled: boolean;
    volume: number;
    rate: number;
    engineMode: 'local' | 'neural';
    autoPlayMode: 'auto' | 'chapter' | 'row';
    selectedVoice?: string;

    // Data Windows
    currentSentences: string[];
    windowSentences?: WindowSentence[]; // [NEW] 100-sentence sliding window (25 back, 75 forward)
    allChapters: { title: string, level: number, index: number, count: number }[]; // Full chapter metadata
    
    // Integrity & Cache
    cacheCount: number;
    cacheSizeBytes: number;
    playbackIntentId: number;
    batchIntentId: number;
    lastLoadType?: 'cache' | 'synth' | 'none';
    activeSessionId?: string;
    logLevel: LogLevel;
    snippetHistory?: SnippetHistory;
    isHydrated?: boolean;
}


export interface AudioVoice {
    id: string;
    name: string;
    lang: string;
    engine: 'local' | 'neural';
}

export enum AudioEngineEventType {
    PLAYING = 'PLAYING',
    PAUSED = 'PAUSED',
    ENDED = 'ENDED',
    STALLED = 'STALLED',
    ERROR = 'ERROR',
    BUFFERING = 'BUFFERING'
}

export interface AudioEngineEvent {
    type: AudioEngineEventType;
    intentId?: number;
    batchId?: number;
    cacheKey?: string;
    message?: string;
}

/**
 * [AUTORADIANT] AudioStrategy is decommissioned.
 * WebviewAudioEngine now acts as a unified player.
 */


export interface SnippetEntry {
    name: string;
    fsPath: string;
    uri: string;
    timestamp: number;
}

export interface SnippetSession {
    id: string; // The session UUID/folder name
    sessionName: string; // The human-readable title OR fallback to id
    displayName?: string; // Explicit human-readable title if available
    snippets: SnippetEntry[];
}

export type SnippetHistory = SnippetSession[];


/**
 * Commands sent FROM Extension TO Webview
 */
export enum IncomingCommand {
    // Synchronization & State
    UI_SYNC = 'UI_SYNC',
    LOG_MESSAGE = 'LOG_MESSAGE',

    // Snippet Management (Antigravity)
    SNIPPET_SAVED = 'SNIPPET_SAVED',
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
    SYNTHESIS_READY = 'SYNTHESIS_READY',
    SYNTHESIS_STARTING = 'SYNTHESIS_STARTING',
    CLEAR_CACHE_WIPE = 'CLEAR_CACHE_WIPE',
    CACHE_STATS_UPDATE = 'CACHE_STATS_UPDATE',
    CACHE_MANIFEST = 'CACHE_MANIFEST',
    GLOBAL_SITREP = 'GLOBAL_SITREP',
    COMMAND_RESULT = 'COMMAND_RESULT',
    SPEAK_LOCAL = 'SPEAK_LOCAL'
}


export interface CacheDelta {
    added: string[];
    removed: string[];
    isFullSync: boolean;
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
    FETCH_AUDIO = 'FETCH_AUDIO',
    CLEAR_CACHE = 'CLEAR_CACHE',
    TOGGLE_PLAY_PAUSE = 'TOGGLE_PLAY_PAUSE',
    LOG = 'log',
    ERROR = 'error',
    // Snippet Lookup (Antigravity)
    GET_ALL_SNIPPET_HISTORY = 'GET_ALL_SNIPPET_HISTORY',
    LOAD_SNIPPET = 'LOAD_SNIPPET',
    SET_ACTIVE_MODE = 'SET_ACTIVE_MODE',
    REPORT_CACHE_DELTA = 'REPORT_CACHE_DELTA',
    REPORT_VOICES = 'reportVoices',
    PLAYBACK_BLOCKED = 'PLAYBACK_BLOCKED',
    SET_AUTO_INJECT_SITREP = 'SET_AUTO_INJECT_SITREP',
    EXECUTE_COMMAND = 'EXECUTE_COMMAND',
    SET_AUTOPLAY_INJECTION = 'SET_AUTOPLAY_INJECTION'
}
