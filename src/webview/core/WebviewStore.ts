import { MessageClient } from './MessageClient';
import { IncomingCommand, UISyncPacket, OutgoingAction, LogLevel, WindowSentence } from '../../common/types';
import { generateCacheKey } from '../../common/cachePolicy';

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
  isPaused: true,
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
  cacheStats: { count: 0, size: 0 },
  playbackIntentId: 0,
  batchIntentId: 0,
  rate: 0,
  volume: 50,
  activeMode: 'FILE',
  logLevel: LogLevel.STANDARD,
  availableVoices: {
    local: [],
    neural: []
  },
  windowSentences: [],
  selectedVoice: undefined
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
  isHandshakeComplete: boolean;
};

export type Selector<T, S = StoreState> = (state: S) => T;
export type Listener<T> = (value: T) => void;

/**
 * WebviewStore: Simplified & Unified Reactive Store (v2.3.1)
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
      isHandshakeComplete: false,
      playbackIntentId: Date.now(),
      batchIntentId: Date.now()
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
      isHandshakeComplete: false,
      playbackIntentId: Date.now(),
      batchIntentId: Date.now()
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
    const text = this.state.currentText;
    if (!text) {
      return `${this.state.currentChapterIndex}_${this.state.state.currentSentenceIndex}`;
    }

    return generateCacheKey(
      text,
      this.state.selectedVoice || 'default',
      this.state.rate,
      this.state.state.activeDocumentUri
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
    const wasHydrated = this._isHydrated;

    if ((patch.state || patch.isHandshakeComplete === true) && !this._isHydrated) {
      this._isHydrated = true;
      if (patch.state){ patch.isHandshakeComplete = true;}
    }

    // [PERFORMANCE] Prevent redundant updates if state is identical,
    // BUT always allow the first hydration to propagate to ensure UI parity.
    const hasChanges = Object.entries(patch).some(([key, value]) => !this.isEqual(value, (this.state as any)[key]));
    if (wasHydrated && !hasChanges) {
      return;
    }

    const oldState = { ...this.state };

    // [SOVEREIGNTY] Timestamp local stalls
    // We update lastStallAt if we are starting a stall, OR if the source is explicitly being changed.
    const isStartingStall = (patch.isAwaitingSync && !oldState.isAwaitingSync) || (patch.playbackStalled && !oldState.playbackStalled);
    const isChangingSource = patch.lastStallSource && patch.lastStallSource !== oldState.lastStallSource;

    if (isStartingStall || isChangingSource) {
      patch.lastStallAt = Date.now();
      // If source not provided in patch, default to AUTO if starting playbackStalled, else USER
      if (!patch.lastStallSource) {
        patch.lastStallSource = patch.playbackStalled ? 'AUTO' : 'USER';
      }
    }

    // [HARDENING] Deep merge nested state to prevent partial syncs from overwriting metadata
    const finalPatch = { ...patch };
    if (patch.state && this.state.state) {
      finalPatch.state = { ...this.state.state, ...patch.state };
    } else if ('state' in patch && !patch.state) {
      // If the patch explicitly contains 'state' but it's null/undefined, 
      // we strip it to prevent wiping the existing authoritative state.
      delete finalPatch.state;
    }

    // [SOVEREIGNTY] Reflective Patching: Synchronize Twin Properties
    // Ensures flat properties and nested 'state' properties never drift.
    if (finalPatch.state) {
      if (finalPatch.currentChapterIndex !== undefined) {
        finalPatch.state.currentChapterIndex = finalPatch.currentChapterIndex;
      } else if (finalPatch.state.currentChapterIndex !== undefined) {
        (finalPatch as any).currentChapterIndex = finalPatch.state.currentChapterIndex;
      }

      if (finalPatch.activeMode !== undefined) {
        finalPatch.state.activeMode = finalPatch.activeMode;
      } else if (finalPatch.state.activeMode !== undefined) {
        (finalPatch as any).activeMode = finalPatch.state.activeMode;
      }

      // [AUTHORITATIVE TWINS]
      if (finalPatch.autoPlayMode !== undefined) {
        finalPatch.state.autoPlayMode = finalPatch.autoPlayMode;
      } else if (finalPatch.state.autoPlayMode !== undefined) {
        (finalPatch as any).autoPlayMode = finalPatch.state.autoPlayMode;
      }

      if (finalPatch.volume !== undefined) {
        finalPatch.state.volume = finalPatch.volume;
      } else if (finalPatch.state.volume !== undefined) {
        (finalPatch as any).volume = finalPatch.state.volume;
      }

      if (finalPatch.rate !== undefined) {
        finalPatch.state.rate = finalPatch.rate;
      } else if (finalPatch.state.rate !== undefined) {
        (finalPatch as any).rate = finalPatch.state.rate;
      }

      if (finalPatch.engineMode !== undefined) {
        finalPatch.state.engineMode = finalPatch.engineMode;
      } else if (finalPatch.state.engineMode !== undefined) {
        (finalPatch as any).engineMode = finalPatch.state.engineMode;
      }
    } else {
      // If patching flat properties without a 'state' object in the patch,
      // we must reach into the existing nested state to maintain parity.
      const currentNested = this.state.state;
      if (currentNested) {
          if (finalPatch.currentChapterIndex !== undefined) {
            finalPatch.state = { ...currentNested, currentChapterIndex: finalPatch.currentChapterIndex };
          }
          if (finalPatch.activeMode !== undefined) {
            finalPatch.state = { ...(finalPatch.state || currentNested), activeMode: finalPatch.activeMode };
          }
           if (finalPatch.autoPlayMode !== undefined) {
            finalPatch.state = { ...(finalPatch.state || currentNested), autoPlayMode: finalPatch.autoPlayMode };
          }
          if (finalPatch.volume !== undefined) {
            finalPatch.state = { ...(finalPatch.state || currentNested), volume: finalPatch.volume };
          }
          if (finalPatch.rate !== undefined) {
            finalPatch.state = { ...(finalPatch.state || currentNested), rate: finalPatch.rate };
          }
          if (finalPatch.engineMode !== undefined) {
            finalPatch.state = { ...(finalPatch.state || currentNested), engineMode: finalPatch.engineMode };
          }
      }
    }

    if (patch.availableVoices && this.state.availableVoices) {
      finalPatch.availableVoices = { ...this.state.availableVoices, ...patch.availableVoices };
    }
    if (patch.cacheStats && this.state.cacheStats) {
      finalPatch.cacheStats = { ...this.state.cacheStats, ...patch.cacheStats };
    }

    this.state = { ...this.state, ...finalPatch };
    
    // [DNA] Recalculate and Schedule re-evaluation
    this.refreshSyncingState();

    // [HARDENING] Notify listeners
    this.listeners.forEach((entry) => {
      const newValue = entry.selector(this.state);

      // [SOVEREIGNTY] Force notification on first hydration (transition to _isHydrated = true)
      // or if the slice actually changed.
      const shouldNotify = (!wasHydrated && this._isHydrated) || !this.isEqual(newValue, entry.lastValue);

      if (shouldNotify) {
        entry.lastValue = newValue;
        entry.listener(newValue);
      }
    });

    console.log(`[STORE] 💎 State Updated. isSyncing=${this.state.isSyncing}, isSupported=${this.state.state?.focusedIsSupported}, awaitingSync=${this.state.isAwaitingSync}`);
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
    const newId = Date.now();
    this.patchState({ playbackIntentId: newId });
    return newId;
  }

  public resetBatchIntent(): number {
    const newId = Date.now();
    this.patchState({ batchIntentId: newId });
    return newId;
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
