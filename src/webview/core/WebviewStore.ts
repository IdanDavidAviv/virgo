import { MessageClient } from './MessageClient';
import { IncomingCommand, UISyncPacket, OutgoingAction, LogLevel, WindowSentence } from '../../common/types';
import { generateCacheKey } from '../../common/cachePolicy';

/**
 * DEFAULT_SYNC_PACKET: The authoritative starting point for the synchronized extension state.
 * Ensures that all reactive properties have valid defaults before the first UI_SYNC arrives.
 */
export const DEFAULT_SYNC_PACKET: UISyncPacket = {
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
    activeMode: 'FILE',
    isLooping: false,
    isPlaying: false,
    isPaused: true,
    playbackStalled: false,
    volume: 50,
    rate: 0,
    engineMode: 'local',
    autoPlayMode: 'auto',
    currentSentences: [],
    allChapters: [],
    cacheCount: 0,
    cacheSizeBytes: 0,
    playbackIntentId: 0,
    batchIntentId: 0,
    logLevel: LogLevel.STANDARD,
    availableVoices: {
        local: [],
        neural: []
    },
    windowSentences: [],
    selectedVoice: undefined,
    snippetHistory: []
};

export type StoreState = UISyncPacket & {
  // Transient Local Fields (Not synced from Extension)
  collapsedIndices: Set<number>;
  isAwaitingSync: boolean;
  isLoadingVoices: boolean;
  isDraggingSlider: boolean;
  playbackIntent: 'PLAYING' | 'PAUSED' | 'STOPPED';
  lastStallAt: number;
  lastStallSource: 'USER' | 'AUTO';
  isBuffering: boolean;
  activeQueue: WindowSentence[]; // [FIFO] Authoritative sequence of sentences
  pendingChapterIndex: number;
  neuralBuffer: { count: number, sizeMb: number };
  isSyncing: boolean;
  isHydrated: boolean;
};

export type Selector<T, S = StoreState> = (state: S) => T;
export type Listener<T> = (value: T) => void;

/**
 * WebviewStore: Simplified & Unified Reactive Store (v2.3.2)
 * Mirrors the Extension's StateStore while managing transient UI properties.
 */
export class WebviewStore {
  private static instance: WebviewStore | null = null;

  private state: StoreState;
  private listeners: Set<{
    selector: Selector<any>,
    listener: Listener<any>,
    lastValue: any
  }> = new Set();
  private syncTimer: any = null;
  private readonly STALL_GRACE_MS = 300;
  private readonly SYNC_TIMEOUT_MS = 5000;

  private _isHydrated: boolean = false;

  private constructor() {
    this.state = {
      ...DEFAULT_SYNC_PACKET,
      collapsedIndices: new Set(),
      isAwaitingSync: false,
      isLoadingVoices: false,
      isDraggingSlider: false,
      playbackIntent: 'STOPPED',
      lastStallAt: 0,
      lastStallSource: 'AUTO',
      isBuffering: false,
      activeQueue: [],
      pendingChapterIndex: -1,
      neuralBuffer: { count: 0, sizeMb: 0 },
      isSyncing: false,
      isHydrated: false,
      playbackIntentId: 0,
      batchIntentId: 0
    };
  }

  public static getInstance(): WebviewStore {
    if (!WebviewStore.instance) {
      WebviewStore.instance = new WebviewStore();
      if (typeof window !== 'undefined') {
        (window as any).__WEBVIEW_STORE__ = WebviewStore.instance;
      }
    }
    return WebviewStore.instance;
  }

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

  public dispose(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.listeners.clear();
    this._isHydrated = false;
    // Reset to defaults
    this.state = {
      ...DEFAULT_SYNC_PACKET,
      collapsedIndices: new Set(),
      isAwaitingSync: false,
      isLoadingVoices: false,
      isDraggingSlider: false,
      playbackIntent: 'STOPPED',
      lastStallAt: 0,
      lastStallSource: 'AUTO',
      isBuffering: false,
      activeQueue: [],
      pendingChapterIndex: -1,
      neuralBuffer: { count: 0, sizeMb: 0 },
      isSyncing: false,
      isHydrated: false,
      playbackIntentId: 0,
      batchIntentId: 0
    };
  }

  public isHydrated(): boolean {
    return this._isHydrated;
  }

  public get isSyncing(): boolean {
    return this.calculateSyncingState();
  }

  public getState(): StoreState {
    return this.state;
  }

  /**
   * getUIState() - Proxy for backward compatibility. 
   * In v2.3.1, all state is unified.
   */
  public getUIState(): StoreState {
    return this.state;
  }

  public getSentenceKey(): string {
    const text = (this.state as any).currentText || '';
    
    return generateCacheKey(
      text,
      this.state.selectedVoice || 'default',
      this.state.rate,
      this.state.activeDocumentUri
    );
  }

  /**
   * Unified subscribe method.
   */
  public subscribe<T>(selector: Selector<T>, listener: Listener<T>): () => void {
    const initialValue = selector(this.state);
    const entry = { selector, listener, lastValue: initialValue };
    this.listeners.add(entry);
    
    // [SOVEREIGNTY] Immediately invoke the listener with the current value
    // to ensure the subscribing component is always in sync with reality.
    try {
      listener(initialValue);
    } catch (err) {
      console.error(`[Store] Subscription initial call failed:`, err);
    }

    return () => this.listeners.delete(entry);
  }

  /**
   * Legacy proxy for subscribeUI.
   */
  public subscribeUI<T>(selector: Selector<T>, listener: Listener<T>): () => void {
    return this.subscribe(selector, listener);
  }

  public patchState(patch: Partial<StoreState>): void {
    // [v2.3.1 OMEGA] Immediate Grounding
    // Ensure intent baseline is set as soon as a view is available.
    if (this.state.playbackIntentId === 0 && patch.playbackIntentId === undefined) { patch.playbackIntentId = 1; }
    if (this.state.batchIntentId === 0 && patch.batchIntentId === undefined) { patch.batchIntentId = 1; }

    // [SOVEREIGNTY] Monotonic Intent Protection
    if (patch.playbackIntentId !== undefined && patch.playbackIntentId < this.state.playbackIntentId) {
      delete patch.playbackIntentId;
    }
    if (patch.batchIntentId !== undefined && patch.batchIntentId < this.state.batchIntentId) {
      delete patch.batchIntentId;
    }

    const wasHydrated = this._isHydrated;

    // Simple hydration check (if it looks like a sync packet)
    if ((patch.activeFileName || patch.isHydrated === true) && !this._isHydrated) {
      this._isHydrated = true;
      patch.isHydrated = true;
    }

    // [PERFORMANCE] Prevent redundant updates if state is identical,
    // BUT always allow the first hydration to propagate to ensure UI parity.
    const hasChanges = Object.entries(patch).some(([key, value]) => !this.isEqual(value, (this.state as any)[key]));
    if (wasHydrated && !hasChanges) {
      return;
    }

    const oldState = { ...this.state };

    // [SOVEREIGNTY] Timestamp local stalls
    const isStartingStall = (patch.isAwaitingSync && !oldState.isAwaitingSync) || (patch.playbackStalled && !oldState.playbackStalled);
    const isChangingSource = patch.lastStallSource && patch.lastStallSource !== oldState.lastStallSource;

    if (isStartingStall || isChangingSource) {
      patch.lastStallAt = Date.now();
      if (!patch.lastStallSource) {
        patch.lastStallSource = patch.playbackStalled ? 'AUTO' : 'USER';
      }
    }

    // Merge nested objects if they exist in patch
    if (patch.availableVoices && this.state.availableVoices) {
      patch.availableVoices = { ...this.state.availableVoices, ...patch.availableVoices };
    }
    if (patch.cacheStats && this.state.cacheStats) {
      patch.cacheStats = { ...this.state.cacheStats, ...patch.cacheStats };
    }

    this.state = { ...this.state, ...patch };
    
    // [DNA] Recalculate and Schedule re-evaluation
    this.refreshSyncingState();

    // [HARDENING] Notify listeners
    this.listeners.forEach((entry) => {
      const newValue = entry.selector(this.state);
      const shouldNotify = (!wasHydrated && this._isHydrated) || !this.isEqual(newValue, entry.lastValue);

      if (shouldNotify) {
        entry.lastValue = newValue;
        entry.listener(newValue);
      }
    });

    console.log(`[STORE] 💎 State Updated. isSyncing=${this.state.isSyncing}, awaitingSync=${this.state.isAwaitingSync}`);
  }

  public resetCacheStats(): void {
    this.patchState({
      cacheCount: 0,
      cacheSizeBytes: 0,
      cacheStats: { count: 0, size: 0 }
    });
  }

  /** Proxy methods for backward compatibility */
  public updateState(patch: Partial<StoreState>, source: 'remote' | 'local' = 'remote'): void {
    if (source === 'remote' && this.state.isDraggingSlider) { return; }
    this.patchState(patch);
  }
  public updateUIState(patch: Partial<StoreState>): void { this.patchState(patch); }

  public resetLoadingStates(): void {
    this.patchState({
      lastStallAt: 0,
      lastStallSource: 'AUTO',
      isBuffering: false,
      isAwaitingSync: false,
      playbackStalled: false
    });
  }

  public resetPlaybackIntent(): number {
    const nextId = this.state.playbackIntentId + 1;
    this.patchState({ playbackIntentId: nextId });
    return nextId;
  }

  public resetBatchIntent(): number {
    const nextId = this.state.batchIntentId + 1;
    this.patchState({ batchIntentId: nextId });
    return nextId;
  }

  public setQueue(window: WindowSentence[]): void {
    this.patchState({ activeQueue: window });
  }

  /**
   * refreshSyncingState(): Reactive recalculation of the isSyncing state.
   * Resolves "Ghost State" by scheduling re-evaluations when transitions rely on time.
   */
  private refreshSyncingState(): void {
    const wasSyncing = this.state.isSyncing;
    const isSyncing = this.calculateSyncingState();
    
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }

    if (isSyncing !== wasSyncing) {
      this.state.isSyncing = isSyncing;
      // Note: We don't recursively call patchState here to avoid loops.
      // Callers of refreshSyncingState (patchState) will handle listener notification.
    }

    // Schedule next re-evaluation if we are in a transient state
    const { isAwaitingSync, playbackStalled, lastStallAt, lastStallSource, playbackIntent } = this.state;
    if (playbackIntent !== 'PLAYING') {return;}

    if (isAwaitingSync || playbackStalled) {
      const duration = Date.now() - lastStallAt;
      const isUserIntent = lastStallSource === 'USER';
      const grace = isUserIntent ? 0 : this.STALL_GRACE_MS;

      if (!isSyncing && duration < grace) {
        // Pending "Syncing" start after grace period
        this.syncTimer = setTimeout(() => this.patchState({}), grace - duration + 1);
      } else if (isSyncing) {
        // Pending "Syncing" timeout (Force clear after 5s)
        this.syncTimer = setTimeout(() => {
          console.warn('[STORE] ⚠️ Sync Timeout Reached. Force clearing stall state.');
          this.resetLoadingStates();
        }, this.SYNC_TIMEOUT_MS - duration + 1);
      }
    }
  }

  private calculateSyncingState(): boolean {
    const {
      isAwaitingSync = false,
      playbackStalled = false,
      lastStallAt = 0,
      lastStallSource = 'AUTO',
      playbackIntent = 'PAUSED'
    } = this.state;

    if (playbackIntent !== 'PLAYING') {
      return false;
    }

    const isUserIntent = lastStallSource === 'USER';
    const grace = isUserIntent ? 0 : this.STALL_GRACE_MS;
    const duration = Date.now() - lastStallAt;

    return (playbackStalled || isAwaitingSync) && (duration >= grace);
  }

  /**
   * sets the active intent ID globally and notifies all listeners.
   */
  public setIntentIds(playbackId?: number, batchId?: number): void {
    const patch: any = {};
    if (playbackId !== undefined) { patch.playbackIntentId = playbackId; }
    if (batchId !== undefined) { patch.batchIntentId = batchId; }
    this.patchState(patch);
  }

  private isEqual(a: any, b: any): boolean {
    if (a === b) { return true; }
    if (typeof a !== typeof b) { return false; }
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size) { return false; }
      for (const item of a) { if (!b.has(item)) { return false; } }
      return true;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) { return false; }
      return a.every((val, index) => this.isEqual(val, b[index]));
    }
    if (typeof a === 'object' && a !== null && b !== null) {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) { return false; }
      return keysA.every(key => this.isEqual(a[key], b[key]));
    }
    return false;
  }
}
