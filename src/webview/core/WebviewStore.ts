import { MessageClient } from './MessageClient';
import { IncomingCommand, UISyncPacket, OutgoingAction, LogLevel } from '../../common/types';

/**
 * DEFAULT_SYNC_PACKET: The authoritative starting point for the synchronized extension state.
 * Ensures that all reactive properties have valid defaults before the first UI_SYNC arrives.
 */
export const DEFAULT_SYNC_PACKET: UISyncPacket = {
  state: {
    focusedFileName: '',
    focusedRelativeDir: '',
    focusedDocumentUri: null,
    focusedIsSupported: false,
    activeFileName: '',
    activeRelativeDir: '',
    activeDocumentUri: null,
    currentChapterIndex: 0,
    currentSentenceIndex: 0,
    isRefreshing: false,
    isPreviewing: false,
    activeMode: 'FILE'
  },
  isPlaying: false,
  isPaused: false,
  playbackStalled: false,
  currentSentences: [],
  allChapters: [],
  currentChapterIndex: 0,
  totalChapters: 0,
  isLooping: false,
  currentText: '',
  canPrevChapter: false,
  canNextChapter: false,
  canPrevSentence: false,
  canNextSentence: false,
  autoPlayMode: 'auto',
  engineMode: 'local',
  cacheCount: 0,
  cacheSizeBytes: 0,
  rate: 0,
  volume: 50,
  activeMode: 'FILE',
  logLevel: LogLevel.STANDARD,
  availableVoices: {
    local: [],
    neural: []
  },
  selectedVoice: undefined
};

export type Selector<T, S = UISyncPacket> = (state: S) => T;
export type Listener<T> = (value: T) => void;

/**
 * Local UI state that is not synchronized with the extension.
 * Used for transient UI states like intermediate selections or temporary highlights.
 */
export interface LocalUIState {
  collapsedIndices: Set<number>;
  isAwaitingSync: boolean;
  isLoadingVoices: boolean;
  isDraggingSlider: boolean;
  playbackIntent: 'PLAYING' | 'PAUSED' | 'STOPPED';
  lastStallAt: number;
  lastStallSource: 'USER' | 'AUTO';
  isSyncing: boolean;
  isBuffering: boolean;
  pendingChapterIndex: number;
  neuralBuffer: { count: number, sizeMb: number };
  activeMode: 'FILE' | 'SNIPPET';
  snippetHistory: any[];
  playbackIntentId: number;
}

/**
 * WebviewStore: A reactive View-Model that mirrors the Extension's StateStore.
 * Designed for high-performance UI updates via selector-based subscriptions.
 * Also manages local, transient UI state.
 */
export class WebviewStore {
  private static instance: WebviewStore | null = null;
  
  // Extension-synchronized state
  private state: UISyncPacket | null = null;
  private listeners: Set<{ 
    selector: Selector<any, UISyncPacket>, 
    listener: Listener<any>, 
    lastValue: any 
  }> = new Set();

  private _isHydrated: boolean = false;

  // [REINFORCEMENT] Payload Cache
  private previousVoicesHash: string = '';

  // [REINFORCEMENT] Centralized Sync Timer
  private syncTimer: any = null;

  // Local-only transient UI state
  private uiState: LocalUIState = {
    collapsedIndices: new Set(),
    isAwaitingSync: false,
    isLoadingVoices: false,
    isDraggingSlider: false,
    playbackIntent: 'STOPPED',
    lastStallAt: 0,
    lastStallSource: 'AUTO',
    isSyncing: false,
    isBuffering: false,
    pendingChapterIndex: -1,
    neuralBuffer: { count: 0, sizeMb: 0 },
    activeMode: 'FILE',
    snippetHistory: [],
    playbackIntentId: 0
  };

  private uiListeners: Set<{
    selector: Selector<any, LocalUIState>,
    listener: Listener<any>,
    lastValue: any
  }> = new Set();

  private constructor() {
    // [PASSIVE BUCKET] All IPC command listeners moved to PlaybackController.
  }

  /**
   * Returns the singleton instance of WebviewStore.
   */
  public static getInstance(): WebviewStore {
    if (!WebviewStore.instance) {
      WebviewStore.instance = new WebviewStore();
      if (typeof window !== 'undefined') {
        (window as any).__WEBVIEW_STORE__ = WebviewStore.instance;
      }
    }
    return WebviewStore.instance;
  }

  /**
   * Resets the singleton instance and disposes of current listeners.
   */
  public static resetInstance(): void {
    if (typeof window !== 'undefined') {
      (window as any).__WEBVIEW_STORE__ = null;
    }
    MessageClient.resetInstance();
    if (WebviewStore.instance) {
      WebviewStore.instance.dispose();
    }
    WebviewStore.instance = null;
  }

  /**
   * Disposes of the instance by clearing all listeners and state.
   */
  public dispose(): void {
    this.clearSyncTimer();
    this.listeners.clear();
    this.uiListeners.clear();
    this.state = null;
    this._isHydrated = false;
    this.uiState = {
      isAwaitingSync: false,
      isLoadingVoices: false,
      isDraggingSlider: false,
      collapsedIndices: new Set(),
      playbackIntent: 'STOPPED',
      lastStallAt: 0,
      lastStallSource: 'AUTO',
      isSyncing: false,
      isBuffering: false,
      pendingChapterIndex: -1,
      neuralBuffer: { count: 0, sizeMb: 0 },
      activeMode: 'FILE',
      snippetHistory: [],
      playbackIntentId: 0
    };
  }

  /**
   * Returns whether the store has received at least one sync update from the extension.
   */
  public isHydrated(): boolean {
    return this._isHydrated;
  }

  private clearSyncTimer(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Returns the current state.
   */
  public getState(): UISyncPacket {
    return this.state || DEFAULT_SYNC_PACKET;
  }

  /**
   * Returns a unique key for the current sentence (used for caching/playback).
   */
  public getSentenceKey(): string {
    if (!this.state) { return 'default'; }
    return `${this.state.currentChapterIndex}_${this.state.state.currentSentenceIndex}`;
  }

  /**
   * Returns the current local UI state with calculated reactive fields.
   */
  public getUIState(): LocalUIState {
    const now = Date.now();
    const stallDuration = this.uiState.lastStallAt ? now - this.uiState.lastStallAt : 0;
    
    // [GRACE PERIOD] 0ms for USER intent, 400ms for AUTO transitions
    const threshold = this.uiState.lastStallSource === 'USER' ? 0 : 400;
    
    // Stall logic: 
    // - User-initiated (isAwaitingSync) -> Instant (0ms threshold)
    // - Background engine stall (state.playbackStalled) -> 400ms grace period
    const isActuallyStalled = (this.uiState.isAwaitingSync && stallDuration >= threshold) ||
                              (this.state?.playbackStalled && stallDuration >= 400);

    return {
      ...this.uiState,
      // [SOVEREIGNTY] Only show sync-spinner if we ARE trying to play (or if it's an engine-reported stall)
      isSyncing: (isActuallyStalled && this.uiState.playbackIntent === 'PLAYING') || this.uiState.isBuffering
    };
  }

  /**
   * Subscribes to a specific slice of the synchronized extension state.
   */
  public subscribe<T>(selector: Selector<T, UISyncPacket>, listener: Listener<T>): () => void {
    const initialValue = this.state ? selector(this.state) : undefined;
    const entry = { selector, listener, lastValue: initialValue };
    this.listeners.add(entry);
    if (this.state !== null) { listener(initialValue as T); }
    return () => this.listeners.delete(entry);
  }

  /**
   * Subscribes to a specific slice of the local UI state.
   */
  public subscribeUI<T>(selector: Selector<T, LocalUIState>, listener: Listener<T>): () => void {
    const initialValue = selector(this.uiState);
    const entry = { selector, listener, lastValue: initialValue };
    this.uiListeners.add(entry);
    listener(initialValue);
    return () => this.uiListeners.delete(entry);
  }

  /**
   * [PULL MODEL] Signals that the webview is currently pulling binary data from the extension.
   */
  public setBuffering(isBuffering: boolean): void {
    if (this.uiState.isBuffering === isBuffering) { return; }
    this.updateUIState({ isBuffering });
  }

  /**
   * [ANTIGRAVITY] Requests the full snippet history from the extension.
   * Results will be returned via UI_SYNC or a dedicated snippet command.
   */
  public requestSnippetHistory(): void {
    MessageClient.getInstance().postAction(OutgoingAction.GET_ALL_SNIPPET_HISTORY);
  }

  /**
   * [ANTIGRAVITY] Requests to load a specific snippet from disk.
   */
  public loadSnippet(fsPath: string): void {
    MessageClient.getInstance().postAction(OutgoingAction.LOAD_SNIPPET, { fsPath });
  }

  /**
   * [SOVEREIGNTY] Explicitly sets the active storage mode (FILE vs SNIPPET).
   */
  public setActiveMode(mode: 'FILE' | 'SNIPPET'): void {
    MessageClient.getInstance().postAction(OutgoingAction.SET_ACTIVE_MODE, { mode });
  }

  /**
   * Updates the local UI state and notifies subscribers.
   */
  public updateUIState(patch: Partial<LocalUIState>): void {
    const oldState = { ...this.uiState };
    
    // [STABILITY] Timestamp the stall if we just started awaiting sync
    if (patch.isAwaitingSync && !oldState.isAwaitingSync) {
        patch.lastStallAt = Date.now();
    }

    this.uiState = { ...this.uiState, ...patch };

    // Update the flat isSyncing for direct property access (if used)
    const computed = this.getUIState();
    this.uiState.isSyncing = computed.isSyncing;

    this.uiListeners.forEach((entry) => {
      const newValue = entry.selector(this.uiState);
      const oldValue = entry.selector(oldState);
      if (!this.isEqual(newValue, oldValue)) {
        entry.listener(newValue);
      }
    });
  }

  /**
   * [NEW] Atomically resets all loading and sync-lock indicators.
   * Ensures that the UI feels responsive after a user gesture or engine release.
   */
  public resetLoadingStates(): void {
    const patch: Partial<LocalUIState> = { 
        lastStallAt: 0,
        lastStallSource: 'AUTO' // [STABILITY] Clear user intent once sync is resolved or aborted
    };
    if (this.uiState.isAwaitingSync) { patch.isAwaitingSync = false; }
    this.updateUIState(patch);
    
    if (this.state?.playbackStalled) {
        this.patchState({ playbackStalled: false });
    }
  }

  /**
   * [INTENT] Generates a new intent ID to track the current user command.
   * Returns the new ID for immediate use in postAction calls.
   */
  public resetPlaybackIntent(): number {
    const newId = Date.now();
    this.updateUIState({ playbackIntentId: newId });
    return newId;
  }

  public getPlaybackIntentId(): number {
    return this.uiState.playbackIntentId;
  }

  /**
   * [CLEANUP] Resets all cache-related metrics in both synced and local state.
   */
  public resetCacheStats(): void {
    this.patchState({ 
        cacheCount: 0, 
        cacheSizeBytes: 0,
        cacheStats: { count: 0, size: 0 } // [PHASE 4.5] Unified Reset
    });
    this.updateUIState({ neuralBuffer: { count: 0, sizeMb: 0 } });
  }

  /**
   * updateState() - Passive data merge.
   * Logic is now handled by PlaybackController.
   */
  public updateState(newState: Partial<UISyncPacket>, source: 'remote' | 'local' = 'remote'): void {
    if (source === 'remote' && !this._isHydrated) {
      this._isHydrated = true;
    }

    if (this.uiState.isDraggingSlider && source === 'remote') {
      return;
    }

    const oldState = this.state;
    // [HYDRATION] Merge with defaults if this is the first update
    const updatedState = { ...(this.state || DEFAULT_SYNC_PACKET) } as UISyncPacket;
    
    Object.entries(newState).forEach(([key, value]) => {
      if (value !== undefined) {
        if (key === 'state' && typeof value === 'object' && value !== null) {
          updatedState.state = { ...updatedState.state, ...value };
        } else {
          (updatedState as any)[key] = value;
        }

        // [STABILITY] Timestamp background stalls if they just arrived and weren't already tracked
        if (key === 'playbackStalled' && value === true && !oldState?.playbackStalled) {
            this.updateUIState({ 
                lastStallAt: Date.now(), 
                lastStallSource: 'AUTO' // Background stalls are auto
            });
        }
      }
    });

    this.state = updatedState;

    // Notify listeners
    this.listeners.forEach((entry) => {
      const stateToSelect = this.state!;
      const newValue = entry.selector(stateToSelect);
      const oldValue = oldState ? entry.selector(oldState) : entry.selector(DEFAULT_SYNC_PACKET);
      
      if (oldState === null || !this.isEqual(newValue, oldValue)) {
        entry.lastValue = newValue;
        entry.listener(newValue);
      }
    });
  }

  /**
   * Surgically patches a slice of the current state and notifies affected listeners.
   * Used for lightweight IPC commands (e.g. `voices`) that don't emit a full UI_SYNC.
   */
  public patchState(patch: Partial<UISyncPacket>): void {
    this.updateState(patch, 'local');
  }

  private isEqual(a: any, b: any): boolean {
    if (a === b) {return true;}
    if (typeof a !== typeof b) {return false;}
    
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size) {return false;}
      for (const item of a) {if (!b.has(item)) {return false;}}
      return true;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {return false;}
      return a.every((val, index) => val === b[index]);
    }
    
    if (typeof a === 'object' && a !== null && b !== null) {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) {return false;}
      return keysA.every(key => a[key] === b[key]);
    }

    return false;
  }
}
