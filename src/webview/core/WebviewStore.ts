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
  pendingChapterIndex: number;
  isAwaitingSync: boolean;
  isLoadingVoices: boolean;
  isDraggingSlider: boolean;
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

  // Local-only transient UI state
  private uiState: LocalUIState = {
    collapsedIndices: new Set(),
    pendingChapterIndex: -1,
    isAwaitingSync: false,
    isLoadingVoices: false,
    isDraggingSlider: false
  };

  private uiListeners: Set<{
    selector: Selector<any, LocalUIState>,
    listener: Listener<any>,
    lastValue: any
  }> = new Set();

  private constructor() {
    const client = MessageClient.getInstance();
    client.onCommand<UISyncPacket>(IncomingCommand.UI_SYNC, (packet) => {
      this.updateState(packet);
    });
  }

  /**
   * Returns the singleton instance of WebviewStore.
   */
  public static getInstance(): WebviewStore {
    if (typeof window !== 'undefined') {
      if (!(window as any).__WEBVIEW_STORE__) {
        (window as any).__WEBVIEW_STORE__ = new WebviewStore();
      }
      return (window as any).__WEBVIEW_STORE__;
    }
    if (!WebviewStore.instance) {
      WebviewStore.instance = new WebviewStore();
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
    if (WebviewStore.instance) {
      WebviewStore.instance.dispose();
    }
    WebviewStore.instance = null;
  }

  /**
   * Disposes of the instance by clearing all listeners and state.
   */
  public dispose(): void {
    this.listeners.clear();
    this.uiListeners.clear();
    this.state = null;
    this.uiState = {
      isAwaitingSync: false,
      isLoadingVoices: false,
      isDraggingSlider: false,
      collapsedIndices: new Set(),
      pendingChapterIndex: -1
    };
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
  }

  /**
   * Internal method to update the state and notify relevant listeners.
   */
  public updateState(newState: UISyncPacket): void {
    // REINFORCEMENT: Suppress incoming syncs while user is dragging slider to prevent jitter
    if (this.uiState.isDraggingSlider) {
      return;
    }

    const start = performance.now();
    const oldState = this.state;
    
    // Merge state
    const updatedState = { ...this.state, ...newState };

    if (updatedState.rate === undefined) { updatedState.rate = 0; }
    if (updatedState.volume === undefined) { updatedState.volume = 50; }
    
    this.state = updatedState as UISyncPacket;

    let notifiedCount = 0;
    this.listeners.forEach((entry, idx) => {
      const newValue = entry.selector(this.state!);
      if (oldState === null || !this.isEqual(newValue, entry.lastValue)) {
        console.log(`[STORE] Selector #${idx} | Old: ${JSON.stringify(entry.lastValue)} | New: ${JSON.stringify(newValue)}`);
        entry.lastValue = newValue;
        entry.listener(newValue);
        notifiedCount++;
      }
    });

    // 2. [RECOVERY] Log playback state transitions for parity with legacy dashboard.js
    if (oldState === null || oldState.isPlaying !== this.state.isPlaying || oldState.isPaused !== this.state.isPaused) {
        console.log(`[WebviewStore] 🔄 State Sync -> isPlaying: ${this.state.isPlaying} | isPaused: ${this.state.isPaused}`);
    }

    const duration = (performance.now() - start).toFixed(2);
    console.log(`[STORE] Update${oldState === null ? ' (Hydration)' : ''} | Notified: ${notifiedCount}/${this.listeners.size} | Duration: ${duration}ms`);
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
