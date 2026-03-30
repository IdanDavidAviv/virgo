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
    availableVoices: { local: any[], neural: any[] }; // [PHASE 4] Full voice lists
    cacheCount: number;
    cacheSizeBytes: number;
    selectedVoice?: string;
    rate: number;
    volume: number;
}
