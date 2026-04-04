import { MessageClient } from './MessageClient';
import { OutgoingAction, IncomingCommand } from '../../common/types';
import { CacheManager } from '../cacheManager';
import { ToastManager } from '../components/ToastManager';
import { WebviewStore } from './WebviewStore';
import { PlaybackController } from '../playbackController';

/**
 * WebviewAudioEngine: High-Integrity Audio Lifecycle Manager
 * Wraps the HTMLAudioElement and manages raw Blob playback and memory cleanup.
 */
export class WebviewAudioEngine {
  private static instance: WebviewAudioEngine;
  public instanceId: number = Math.random();
  private audio: HTMLAudioElement;
  private activeObjectURLs: Set<string> = new Set();
  private cache: CacheManager;
  private activeIntentId: number = 0;
  public intent: 'PLAYING' | 'PAUSED' | 'STOPPED' = 'PAUSED';
  private adaptiveWaitTimer: any = null;
  private adaptiveWaitResolver: (() => void) | null = null;

  private constructor() {
    this.audio = new Audio();
    this.audio.id = 'neural-player';
    this.audio.preload = 'auto'; // [REINFORCEMENT] Hint for faster startup
    this.cache = new CacheManager();
    this.setupListeners();
  }

  public static getInstance(): WebviewAudioEngine {
    if (typeof window !== 'undefined') {
      if (!(window as any).__AUDIO_ENGINE__) {
        (window as any).__AUDIO_ENGINE__ = new WebviewAudioEngine();
      }
      return (window as any).__AUDIO_ENGINE__;
    }
    if (!this.instance) {
      this.instance = new WebviewAudioEngine();
    }
    return this.instance;
  }

  public static resetInstance(): void {
    if (typeof window !== 'undefined' && (window as any).__AUDIO_ENGINE__) {
        (window as any).__AUDIO_ENGINE__.dispose();
        (window as any).__AUDIO_ENGINE__ = undefined;
    }
    if (this.instance) {
      this.instance.dispose();
      this.instance = undefined as any;
    }
  }

  public dispose(): void {
    this.stop();
    this.audio.pause();
    this.audio.src = '';
  }


  private setupListeners(): void {
    // 1. [REACTIVE] Real-time settings synchronization
    const store = WebviewStore.getInstance();
    store.subscribe((s) => s.volume, (vol) => {
        this.setVolume(vol);
    });
    store.subscribe((s) => s.rate, (rate) => {
        this.setRate(rate);
    });

    // 3. [INTENT SYNC] Cache current intent for lower-level checks
    store.subscribe((s) => store.getUIState().playbackIntent, (intent) => {
        this.intent = intent as any;
    });

    // 2. [REACTIVE] Audio Element State Feedback (Legacy Dashboard Parity)
    this.audio.onplay = () => {
      console.log('[AudioEngine] 🔊 onplay fired');
      store.patchState({ isPlaying: true, isPaused: false, playbackStalled: false });
    };

    this.audio.onpause = () => {
      console.log('[AudioEngine] ⏸️ onpause fired');
      // Fix: Dashboard parity - clear stalled state and isPlaying flag when paused
      // (Fixes StuckLoadingFix.test.ts and PlaybackControls.test.ts)
      store.patchState({ isPaused: true, isPlaying: false, playbackStalled: false });
    };

    this.audio.onwaiting = () => {
      console.log('[AudioEngine] ⏳ onwaiting fired');
      // Only stall if the intent is actually to be playing (Fixes "Zombie Stall" regressions)
      if (this.intent === 'PLAYING') {
        store.patchState({ playbackStalled: true });
      }
    };

    this.audio.onplaying = () => {
      console.log('[AudioEngine] ▶️ onplaying fired');
      store.patchState({ playbackStalled: false });
    };

    this.audio.onended = () => {
      console.log('[AudioEngine] ✅ onended fired → signalling SENTENCE_ENDED');
      const controller = (window as any).__PLAYBACK_CONTROLLER__;
      // Signal the extension host when a sentence finishes.
      if (controller && controller.getState().intent === 'PLAYING') {
        MessageClient.getInstance().postAction(OutgoingAction.SENTENCE_ENDED);
      }
    };

    this.audio.onerror = (e) => {
      const msg = `[AudioEngine] ⛔ Error: ${(e as any).message || 'Unknown audio error'}`;
      console.error(msg);
      ToastManager.show(msg, 'error');
    };
  }

  public async play(): Promise<void> {
    console.log(`[AudioEngine] play() requested | src: ${!!this.audio.src} | paused: ${this.audio.paused}`);

    // If we have active audio and it's just paused, resume it.
    if (this.audio.src && this.audio.paused && !this.audio.ended) {
      try {
        await this.audio.play();
        return;
      } catch (err) {
        console.warn('[AudioEngine] Resume failed', err);
      }
    }
  }

  /**
   * [NEW] Universal Unlocker: Primes the audio subsystem during a user gesture.
   * CALL THIS synchronously in the onClick handler before any async/IPC logic.
   */
  public ensureAudioContext(): void {
    // Calling play() on an empty or paused element during a click handler
    // satisfies the browser's user-gesture requirement for the entire session.
    if (this.audio.paused) {
        const p = this.audio.play();
        if (p instanceof Promise) {
            p.catch(() => {
                // Expected failure on empty src, but the "intent" is registered by browser
            });
        }
        console.log('[AudioEngine] 🔓 Audio subsystem primed via User Gesture');
    }
  }

  public prepareForPlayback(): number {
    this.activeIntentId++;
    console.log('[AudioEngine] 🚀 prepareForPlayback', { intentId: this.activeIntentId });
    return this.activeIntentId;
  }

  /**
   * [v2.0.0] Adaptive JIT Wait: Enters a 30ms silent window while waiting for synthesis.
   * If data arrives within 30ms, we play instantly without showing "Loading..." in the UI.
   */
  public startAdaptiveWait(cacheKey: string, intentId: number): Promise<void> {
    if (intentId < this.activeIntentId) {
      console.log('[AudioEngine] ✋ Ignoring stale Synthesis Starting', { intentId, current: this.activeIntentId });
      return Promise.resolve();
    }
    
    // 1. Update active intent
    this.activeIntentId = intentId;
    this.clearAdaptiveWait();

    console.log('[AudioEngine] ⏳ Entering Adaptive Wait (30ms)', { cacheKey, intentId });
    
    return new Promise((resolve) => {
      this.adaptiveWaitResolver = resolve;
      this.adaptiveWaitTimer = setTimeout(() => {
        console.log('[AudioEngine] ⏳ Adaptive Wait Expired - Showing Loading UI');
        WebviewStore.getInstance().patchState({ playbackStalled: true });
        this.clearAdaptiveWait();
      }, 30);
    });
  }

  private clearAdaptiveWait(): void {
    if (this.adaptiveWaitTimer) {
      clearTimeout(this.adaptiveWaitTimer);
      this.adaptiveWaitTimer = null;
    }
    if (this.adaptiveWaitResolver) {
      this.adaptiveWaitResolver();
      this.adaptiveWaitResolver = null;
    }
  }

  /**
   * [v2.0.0] Direct Data Push: Ingests audio data pushed from the extension.
   */
  public async ingestData(cacheKey: string, base64Data: string, intentId: number): Promise<void> {
    if (intentId < this.activeIntentId) {
        console.log('[AudioEngine] ✋ Ignoring stale Push Data', { intentId, current: this.activeIntentId });
        return;
    }

    // 1. Sanitize input: Strip 'data:audio/...;base64,' prefix if present
    let cleaned = base64Data.trim();
    const match = cleaned.match(/^data:audio\/[^;]+;base64,(.+)$/i);
    if (match) {
        cleaned = match[1];
    }

    const blob = this.base64ToBlob(cleaned, 'audio/mpeg');
    // Always store in cache (non-blocking background task)
    this.cache.set(cacheKey, blob).catch(err => console.error('[AudioEngine] Cache save failed:', err));
    
    // If this is the current active intent (or newer), play it immediately
    if (intentId >= this.activeIntentId) {
        this.activeIntentId = intentId;
        console.log('[AudioEngine] 🔥 JIT Cache Hit via Direct Push - Playing Now', { cacheKey });
        this.clearAdaptiveWait();
        await this.playBlob(blob, cacheKey, intentId);
    }
  }

  /**
   * Plays audio from a base64 string and optionally saves it to the cache.
   */
  public async playFromBase64(base64: string, cacheKey?: string, intentId?: number): Promise<void> {
    console.log('[AudioEngine] playFromBase64 called', { instanceId: this.instanceId, cacheKey, intentId });
    
    if (intentId !== undefined && intentId < this.activeIntentId) {
        console.log('[AudioEngine] ✋ Ignoring stale playFromBase64', { intentId, current: this.activeIntentId });
        return;
    }
    if (intentId !== undefined) {
        this.activeIntentId = intentId;
    }
    
    this.clearAdaptiveWait();
    this.stop(); 

    try {
      // 1. Sanitize input: Strip 'data:audio/...;base64,' prefix if present (Issue #88)
      let cleaned = base64.trim();
      const match = cleaned.match(/^data:audio\/[^;]+;base64,(.+)$/i);
      if (match) {
          cleaned = match[1];
      }

      const blob = this.base64ToBlob(cleaned, 'audio/mpeg');

      // Save to cache asynchronously (#42)
      if (cacheKey) {
        this.cache.set(cacheKey, blob).catch(err => console.error('[AudioEngine] Cache save failed:', err));
      }

      const finalCacheKey = cacheKey || `base64-${Date.now()}`;
      await this.playBlob(blob, finalCacheKey, intentId);
    } catch (err) {
      console.error('[AudioEngine] Failed to play base64 audio:', err);
    }
  }

  /**
   * Plays audio directly from the IndexedDB cache.
   */
  public async playFromCache(cacheKey: string, intentId?: number): Promise<boolean> {
    try {
      const blob = await this.cache.get(cacheKey);
      if (blob) {
        if (intentId !== undefined && intentId < this.activeIntentId) {
            console.log('[AudioEngine] ✋ Ignoring stale playFromCache', { intentId, current: this.activeIntentId });
            return false;
        }
        if (intentId !== undefined) {
            this.activeIntentId = intentId;
        }
        this.clearAdaptiveWait();
        this.stop();
        await this.playBlob(blob, cacheKey, intentId);
        console.log(`[AudioEngine] ⚡ Cache Hit for ${cacheKey}`);
        this.triggerCachePulse();
        return true;
      }
      return false;
    } catch (err) {
      console.error('[AudioEngine] Cache retrieval failed:', err);
      return false;
    }
  }

  public async playBlob(blob: Blob, cacheKey: string, intentId?: number): Promise<void> {
    // 1. Sequence Guard: If this is an old request, ignore it.
    if (intentId !== undefined && intentId < this.activeIntentId) {
        console.warn(`[AudioEngine] 🧟 Ignoring Zombie Audio (Sequence mismatch: ${intentId} < ${this.activeIntentId})`);
        return;
    }
    if (intentId !== undefined) {
      this.activeIntentId = intentId;
    }

    // 2. Intent Guard: Using PlaybackController for authoritative intent
    const controller = PlaybackController.getInstance();
    if (controller && controller.getState().intent === 'STOPPED') {
      console.log('[AudioEngine] 🧟 Ignoring Zombie Audio (Controller Intent was STOPPED)');
      return;
    }

    // Immediate revocation of previous blob URL (Dashboard Parity line 262)
    const oldUrl = this.audio.src;
    if (oldUrl.startsWith('blob:')) {
      this.revokeUrl(oldUrl);
    }

    const url = URL.createObjectURL(blob);
    this.activeObjectURLs.add(url);
    this.audio.src = url;

    // Apply current settings before load/play
    const store = WebviewStore.getInstance();
    const state = store.getState();
    if (state) {
      const vol = state.volume ?? 50;
      this.audio.volume = Math.max(0, Math.min(1, vol / 100));
      const r = state.rate ?? 0;
      this.audio.playbackRate = r >= 0 ? 1 + (r / 10) : 1 + (r / 20);
    }

    // Only auto-play if we are in PLAYING intent.
    if (!controller || controller.getState().intent === 'PLAYING') {
      await this.audio.play();
    }
  }

  public pause(): void {
    this.audio.pause();
    // [IMMEDIATE] Clear any pending sync locks or stall timers (fixes LoadingLifecycle.test.ts)
    WebviewStore.getInstance().resetLoadingStates();
    WebviewStore.getInstance().patchState({ 
        isPaused: true, 
        isPlaying: false, 
        playbackStalled: false 
    });
  }

  public resume(): void {
    if (this.audio.src) {
      this.audio.play().catch(console.error);
    }
  }

  public stop(): void {
    console.log('[AudioEngine] ⏹️ Stop requested');
    this.audio.pause();
    this.audio.currentTime = 0;
    
    // Always clear src to release network resources and prevent any buffering
    const oldUrl = this.audio.src;
    this.audio.src = ''; 
    
    if (oldUrl.startsWith('blob:')) {
      this.revokeUrl(oldUrl);
    }
  }

  /**
   * Purges all tracked object URLs to prevent memory leaks during rapid skips.
   */
  public purgeMemory(): void {
    console.log('[AudioEngine] 🧹 PURGE_MEMORY: Revoking all known object URLs.');
    this.stop();
    this.activeObjectURLs.forEach(url => {
        try { URL.revokeObjectURL(url); } catch (e) {}
    });
    this.activeObjectURLs.clear();
  }

  /**
   * Triggers a visual pulse on the cache debug tag to indicate a cache hit (#42)
   */
  public triggerCachePulse(): void {
    const tag = document.getElementById('cache-debug-tag');
    if (tag) {
        tag.classList.add('pulse');
        setTimeout(() => tag.classList.remove('pulse'), 400);
    }
  }

  /**
   * High-Performance Base64 to Blob conversion.
   * Uses 512-byte slicing to prevent memory fragmentation on large chapters.
   */
  private base64ToBlob(base64: string, contentType: string = 'audio/mpeg', sliceSize: number = 512): Blob {
    const byteCharacters = atob(base64);
    const byteArrays: Uint8Array[] = [];

    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
      const slice = byteCharacters.slice(offset, offset + sliceSize);
      const byteNumbers = new Uint8Array(slice.length);
      
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      
      byteArrays.push(byteNumbers);
    }

    return new Blob(byteArrays as any, { type: contentType });
  }

  private revokeUrl(url: string): void {
    if (this.activeObjectURLs.has(url)) {
      URL.revokeObjectURL(url);
      this.activeObjectURLs.delete(url);
    }
  }

  /**
   * Sets the audio volume (0.0 to 1.0).
   */
  public setVolume(value: number): void {
    if (!Number.isFinite(value)) { return; }
    // Sliders provide 0-100, HTMLAudioElement expects 0.0 to 1.0
    this.audio.volume = Math.max(0, Math.min(1, value / 100));
  }

  /**
   * Sets the playback rate (0.5 to 4.0).
   */
  public setRate(value: number): void {
    if (!Number.isFinite(value)) { return; }
    // Map -10..10 to a usable playback rate (e.g. 0.5x to 2.0x)
    // Matches logic in playBlob
    this.audio.playbackRate = value >= 0 ? 1 + (value / 10) : 1 + (value / 20);
  }

  /**
   * Internal reference for the DOM element if needed (e.g., for visualizers).
   */
  public getAudioElement(): HTMLAudioElement {
    return this.audio;
  }


}
