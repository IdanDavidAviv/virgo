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
  isSelectingVoice: false,
  activeMode: 'FILE',
  isLooping: false,
  isPlaying: false,
  isPaused: true,
  playbackStalled: false,
  volume: 50,
  rate: 1.0,
  activeSessionId: '',
  engineMode: 'local',
  autoPlayMode: 'auto',
  currentSentences: [],
  allChapters: [],
  cacheCount: 0,
  cacheSizeBytes: 0,
  playbackIntentId: 1,
  batchIntentId: 1,
  logLevel: LogLevel.STANDARD,
  windowSentences: [],
  selectedVoice: undefined,
  snippetHistory: [],
  isHydrated: false,
  playbackAuthorized: false
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
  availableVoices?: { local: any[], neural: any[] };
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
      playbackIntentId: 1,
      batchIntentId: 1
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
      playbackIntentId: 1,
      batchIntentId: 1
    };
  }

  /** Accessor for hydration state — used by tests and external callers. */
  public isHydrated(): boolean {
    return this.state.isHydrated;
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
    const currentIntentId = this.state.playbackIntentId;
    const incomingIntentId = patch.playbackIntentId ?? currentIntentId;

    // [SOVEREIGNTY] Monotonic Intent Protection / Segmented Sovereignty
    const isStale = incomingIntentId < currentIntentId;

    if (isStale) {
      console.warn(`[STORE] STALE PACKET DETECTED (${incomingIntentId} < ${currentIntentId}). Continuing with non-disruptive fields.`);
    }

    const wasHydrated = this.state.isHydrated;

    // 1. Sanitize patch: Remove undefined values to prevent accidental state wiping during spread
    const activePatch = { ...patch };
    Object.keys(activePatch).forEach(key => {
      if ((activePatch as any)[key] === undefined) {
        delete (activePatch as any)[key];
      }
    });

    // [SOVEREIGNTY] Surgical Filtering: Prevent stale packets from hijacking playback thread
    if (isStale) {
      const SOVEREIGN_FIELDS: (keyof StoreState)[] = [
        'isPlaying',
        'isPaused',
        'currentChapterIndex',
        'currentSentenceIndex',
        'activeDocumentUri',
        'isBuffering',
        'playbackStalled',
        // [3.2.C] Protect intent IDs: a stale packet must not overwrite repaired IDs
        // (e.g. after PROTOCOL_REPAIR advances batchId from 0→N, a queued sync must not
        //  restore 0 and trigger another double-play oscillation cycle).
        'playbackIntentId',
        'batchIntentId'
      ];
      SOVEREIGN_FIELDS.forEach(field => {
        if (field in activePatch) {
          delete (activePatch as any)[field];
        }
      });
    }

    // 2. Hydration logic: Aggressive Enforcement [DIAGNOSTIC]
    const hasDocData = (activePatch.allChapters && activePatch.allChapters.length > 0) || activePatch.activeFileName;

    if (activePatch.isHydrated === true) {
      console.log('[STORE] Explicit Hydration Signal Received.');
      activePatch.isHydrated = true;
    } else if (hasDocData && !this.state.isHydrated) {
      console.warn('[STORE] FORCE HYDRATION triggered by contextual data arrival.');
      activePatch.isHydrated = true;
    }

    // [STABILITY] Pulse-aware isRefreshing logic
    // If we are hydrated but isRefreshing is true, it means we are in Pulse 2 or a settings change.
    // We should not block the entire UI if we are already hydrated.

    // 3. Change detection
    const changedKeys = Object.keys(activePatch).filter(key => !this.isEqual((activePatch as any)[key], (this.state as any)[key]));
    const hasChanges = changedKeys.length > 0;

    // [SURGICAL TELEMETRY] Log transitions of the voice loading lock
    if ('isLoadingVoices' in activePatch && activePatch.isLoadingVoices !== this.state.isLoadingVoices) {
      console.log(`[WebviewStore] 🔊 isLoadingVoices: ${this.state.isLoadingVoices} -> ${activePatch.isLoadingVoices}`);
    }

    if (!hasChanges && wasHydrated) {
      return;
    }

    // 4. Playback Stall logic
    const isStartingStall = (activePatch.isAwaitingSync === true || activePatch.playbackStalled === true) &&
      !(this.state.isAwaitingSync || this.state.playbackStalled);
    const isChangingSource = activePatch.lastStallSource !== undefined && activePatch.lastStallSource !== this.state.lastStallSource;

    if (isStartingStall || isChangingSource) {
      activePatch.lastStallAt = Date.now();
      if (!activePatch.lastStallSource) {
        activePatch.lastStallSource = activePatch.playbackStalled ? 'AUTO' : 'USER';
      }
    }


    // 6. Apply atomic update
    this.state = { ...this.state, ...activePatch };

    // [DNA] Recalculate and Schedule re-evaluation
    this.refreshSyncingState();

    // [HARDENING] Notify listeners
    this.listeners.forEach((entry) => {
      const newValue = entry.selector(this.state);
      const shouldNotify = (!wasHydrated && this.state.isHydrated) || !this.isEqual(newValue, entry.lastValue);

      if (shouldNotify) {
        entry.lastValue = newValue;
        entry.listener(newValue);
      }
    });
    console.log(`[STORE] State Updated [${changedKeys.join(', ')}]. isSyncing=${this.state.isSyncing}, awaitingSync=${this.state.isAwaitingSync}`);

    // [HARDENING] ASCII Signal for automation visibility
    console.log('[STORE-SYNC-COMPLETE]');
  }

  /**
   * Hydrates the voice list from the extension.
   * This is a TRANSIENT field — not synced via UI_SYNC packet.
   */
  public setAvailableVoices(local: any[], neural: any[]): void {
    console.log(`[STORE] Hydrating Voices: local=${local.length}, neural=${neural.length}`);
    this.patchState({
      availableVoices: { local, neural },
      isLoadingVoices: false
    });
  }

  public resetCacheStats(): void {
    this.patchState({
      cacheCount: 0,
      cacheSizeBytes: 0
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
    if (playbackIntent !== 'PLAYING') { return; }

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

    // URI Comparison: Robust check for VS Code URI-like objects
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const isUriA = typeof a.scheme === 'string' && typeof a.path === 'string';
      const isUriB = typeof b.scheme === 'string' && typeof b.path === 'string';

      if (isUriA && isUriB) {
        return a.scheme === b.scheme &&
          a.path === b.path &&
          a.query === b.query &&
          a.fragment === b.fragment;
      }
    }

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
      if (a instanceof Set || b instanceof Set) { return false; }
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) { return false; }
      return keysA.every(key => this.isEqual((a as any)[key], (b as any)[key]));
    }
    return false;
  }
}
