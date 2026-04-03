import { MessageClient } from './MessageClient';
import { IncomingCommand, UISyncPacket } from '../../common/types';

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
  pendingChapterIndex: number;
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

  // [REINFORCEMENT] Intent Sovereignty (Sequence Guard)
  private lastIntentId: number = 0;
  private intentExpiry: number = 0;
  private readonly INTENT_TIMEOUT_MS = 500;

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
    pendingChapterIndex: -1
  };

  private uiListeners: Set<{
    selector: Selector<any, LocalUIState>,
    listener: Listener<any>,
    lastValue: any
  }> = new Set();

  private constructor() {
    const client = MessageClient.getInstance();
    client.onCommand<UISyncPacket>(IncomingCommand.UI_SYNC, (packet) => {
      this.updateState(packet, 'remote');
    });
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
    this.lastIntentId = 0;
    this.intentExpiry = 0;
    this.uiState = {
      isAwaitingSync: false,
      isLoadingVoices: false,
      isDraggingSlider: false,
      collapsedIndices: new Set(),
      playbackIntent: 'STOPPED',
      lastStallAt: 0,
      lastStallSource: 'AUTO',
      isSyncing: false,
      pendingChapterIndex: -1
    };
  }

  private clearSyncTimer(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * [CORE] Centralized sync state logic.
   * Rules:
   * 1. If isAwaitingSync (User Action) -> isSyncing = true IMMEDIATELY (0ms).
   * 2. If stalled/synth (Engine)       -> isSyncing = true after 400ms.
   * 3. If healthy                     -> isSyncing = false IMMEDIATELY.
   */
  private refreshSyncingState(): void {
    const isAwaitingSync = this.uiState.isAwaitingSync;
    const isStalled = !!(this.state?.playbackStalled && this.state?.isPlaying);
    // [ROBUST] If intent has expired, treat as background sync (fixes flicker in PlaybackStateAgnostic.test.ts)
    const isAutoStall = this.uiState.lastStallSource === 'AUTO' || Date.now() >= this.intentExpiry;

    // 1. User Intent (High Priority, Instant)
    if (isAwaitingSync && !isAutoStall) {
        this.clearSyncTimer();
        if (!this.uiState.isSyncing) {
            this.updateUIState({ isSyncing: true });
        }
        return;
    }

    // 2. Background Stall or Auto-Transition (Low Priority, 400ms Grace Period)
    if (isStalled || (isAwaitingSync && isAutoStall)) {
        if (this.uiState.isSyncing || this.syncTimer) {
            return;
        }
        
        this.syncTimer = setTimeout(() => {
            this.syncTimer = null;
            this.updateUIState({ isSyncing: true });
        }, 400);
        return;
    }

    // 3. Status Healthy (Clear instantly)
    this.clearSyncTimer();
    if (this.uiState.isSyncing) {
        this.updateUIState({ isSyncing: false });
    }
  }

  /**
   * Returns the current state.
   */
  public getState(): UISyncPacket | null {
    return this.state;
  }

  /**
   * Generates a unique key for the current sentence audio segment.
   * Format: voice-docId-salt-chapter-sentence
   */
  public getSentenceKey(): string | null {
    const s = this.state;
    if (!s) { return null; }
{}    const voice = s.selectedVoice || 'default';
    const uri = s.state.activeDocumentUri || 'unknown';
    const salt = s.state.versionSalt || '0';
    return `${voice}-${uri}-${salt}-${s.state.currentChapterIndex}-${s.state.currentSentenceIndex}`;
  }

  /**
   * Returns the current local UI state.
   */
  public getUIState(): LocalUIState {
    return this.uiState;
  }

  /**
   * Subscribes to a specific slice of the synchronized extension state.
   * The listener is only called if the selected value changes.
   */
  public subscribe<T>(selector: Selector<T, UISyncPacket>, listener: Listener<T>): () => void {
    const initialValue = this.state ? selector(this.state) : undefined;
    const entry = { selector, listener, lastValue: initialValue };
    this.listeners.add(entry);
    
    // Immediate notification of current value if state is already hydrated
    if (this.state !== null) {
      listener(initialValue as T);
    }

    return () => this.listeners.delete(entry);
  }

  /**
   * Subscribes to a specific slice of the local UI state.
   */
  public subscribeUI<T>(selector: Selector<T, LocalUIState>, listener: Listener<T>): () => void {
    const initialValue = selector(this.uiState);
    const entry = { selector, listener, lastValue: initialValue };
    this.uiListeners.add(entry);
    
    // Always notify immediately for local state
    listener(initialValue);

    return () => this.uiListeners.delete(entry);
  }

  /**
   * Updates the local UI state and notifies subscribers.
   */
  public updateUIState(patch: Partial<LocalUIState>): void {
    const oldState = { ...this.uiState };
    this.uiState = { ...this.uiState, ...patch };

    this.uiListeners.forEach((entry) => {
      const newValue = entry.selector(this.uiState);
      const oldValue = entry.selector(oldState);
      if (!this.isEqual(newValue, oldValue)) {
        entry.listener(newValue);
      }
    });

    // Reactively refresh syncing state if underlying triggers changed
    if (patch.isAwaitingSync !== undefined) {
        this.refreshSyncingState();
    }
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
   * Internal method to update the state and notify relevant listeners.
   */
  public updateState(newState: Partial<UISyncPacket>, source: 'remote' | 'local' = 'local'): void {
    if (source === 'remote') {
      this.updateUIState({ 
        isAwaitingSync: false
      });
    }

    // 1. REINFORCEMENT: Suppress incoming syncs while user is dragging slider
    if (this.uiState.isDraggingSlider && source === 'remote') {
      return;
    }

    // 2. [REINFORCEMENT] Intent Sovereignty Guard
    const now = Date.now();
    const hasActiveIntent = this.lastIntentId > 0 && now < this.intentExpiry;

    const start = performance.now();
    
    // If the voices seem identical in size and sample, we avoid a full merge to save main-thread time.
    if (newState.availableVoices && source === 'remote') {
        const currentVoices = newState.availableVoices;
        // Robust gating: stringify the voice list to detect content changes, not just reference changes
        const currentHash = JSON.stringify(currentVoices);
        if (currentHash === this.previousVoicesHash && this.state?.availableVoices) {
            // Keep existing reference to avoid re-triggering massive voice list listeners
            newState.availableVoices = this.state.availableVoices;
        } else {
            this.previousVoicesHash = currentHash;
        }
    }

    // 3. Merge state
    const oldState = this.state;
    const updatedState = { ...this.state, ...newState } as UISyncPacket;

    // Apply Sovereignty Guard if needed
    if (hasActiveIntent && oldState && source === 'remote') {
        // Protect the optimistic desire from being overwritten by delayed sync packets
        updatedState.isPlaying = oldState.isPlaying;
        updatedState.isPaused = oldState.isPaused;
        updatedState.playbackStalled = oldState.playbackStalled;
        updatedState.autoPlayMode = oldState.autoPlayMode;
        
        // Protect document context unless a new real document is arriving
        if (oldState.state && updatedState.state) {
            const isOptimisticLoading = oldState.state.activeDocumentUri === 'loading';
            const isRemoteLoading = newState.state?.activeDocumentUri === 'loading';
            
            // Only protect if we are still in sync-handshake and haven't received a real URI yet
            if (!isRemoteLoading && (updatedState.state.activeDocumentUri === null || isOptimisticLoading)) {
                // If remote says null but we are optimistic, keep the optimistic value
            } else {
                // Allow the update
            }
            
            // [REFINED] Selective protection
            if (isOptimisticLoading && (newState.state?.activeDocumentUri === null || !newState.state?.activeDocumentUri)) {
                updatedState.state = { 
                    ...updatedState.state, 
                    activeDocumentUri: oldState.state.activeDocumentUri,
                    activeFileName: oldState.state.activeFileName
                };
            }
        }
    }

    if (updatedState.rate === undefined) { updatedState.rate = 0; } // [PARITY] Fixed regression from 1.0
    if (updatedState.volume === undefined) { updatedState.volume = 50; }
    
    this.state = updatedState;

    let notifiedCount = 0;
    let idx = 0;
    this.listeners.forEach((entry) => {
      const newValue = entry.selector(this.state!);
      if (oldState === null || !this.isEqual(newValue, entry.lastValue)) {
        entry.lastValue = newValue;
        entry.listener(newValue);
        notifiedCount++;
      }
      idx++;
    });

    if (oldState === null || oldState.isPlaying !== this.state.isPlaying || oldState.isPaused !== this.state.isPaused) {
        // Log state changes internally
    }

    const duration = (performance.now() - start).toFixed(2);
    if (Number(duration) > 5) {
        console.warn(`[STORE] Slow Update (${duration}ms) | Notified: ${notifiedCount}/${this.listeners.size}`);
    }

    // Reactively refresh syncing state if underlying triggers changed
    if (newState.playbackStalled !== undefined || newState.isPlaying !== undefined) {
        this.refreshSyncingState();
    }
  }

  /**
   * [NEW] Optimistically patches the store state and protects it from sync overwrites
   * for a short duration (INTENT_TIMEOUT_MS).
   */
  public optimisticPatch(patch: Partial<UISyncPacket>, options: { isAwaitingSync?: boolean, action?: string, intentTimeout?: number } = {}): void {
    if (!this.state) { 
        // Hydrate with empty state if missing to support testing/initial actions
        this.state = ({ 
            isPlaying: false, 
            isPaused: true, 
            playbackStalled: false,
            currentSentenceIndex: 0,
            currentChapterIndex: 0,
            totalSentences: 0,
            totalChapters: 0,
            availableVoices: { local: [], neural: [] },
            state: {} as any
        } as unknown) as UISyncPacket;
    }
    
    this.lastIntentId++;
    const timeout = options.intentTimeout || this.INTENT_TIMEOUT_MS;
    this.intentExpiry = Date.now() + timeout;
    
    // [REINFORCEMENT] Reset all loading and stall states before initiating a new user intent.
    // This prevents "Zombie Stalls" from a previous engine release.
    this.resetLoadingStates();

    // [REINFORCEMENT] Derive and track user intent
    let intent: 'PLAYING' | 'PAUSED' | 'STOPPED' = this.uiState.playbackIntent;
    if (patch.isPlaying === false) { intent = 'STOPPED'; } // STOP has highest priority
    else if (patch.isPaused === false) { intent = 'PLAYING'; }
    else if (patch.isPaused === true) { intent = 'PAUSED'; }
    
    this.updateUIState({ 
        playbackIntent: intent,
        isAwaitingSync: options.isAwaitingSync || false,
        lastStallSource: 'USER',
        lastStallAt: Date.now() // Reset timer for immediate user feedback
    });

    // Apply patch immediately and notify listeners synchronously
    this.updateState({ ...this.state, ...patch } as any, 'local');
  }

  /**
   * Surgically patches a slice of the current state and notifies affected listeners.
   * Used for lightweight IPC commands (e.g. `voices`) that don't emit a full UI_SYNC.
   */
  public patchState(patch: Partial<UISyncPacket>): void {
    if (!this.state) { return; }
    this.updateState({ ...this.state, ...patch });
  }

  /**
   * Simple equality check (shallow for objects/arrays, strict for primitives).
   */
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
