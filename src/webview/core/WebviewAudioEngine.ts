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
  private pendingCacheKey: string | null = null;
  private targetCacheKey: string | null = null;
  public intent: 'PLAYING' | 'PAUSED' | 'STOPPED' = 'PAUSED';
  private waitTimers: Map<string, any> = new Map();
  private waitResolvers: Map<string, () => void> = new Map();
  private sovereignUrl: string | null = null;

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
    const isSovereign = () => {
      // Comparison logic for Blob URLs and current intent
      if (!this.audio.src || this.audio.src === 'null') {
        return false;
      }
      if (this.audio.src !== this.sovereignUrl) {
          console.warn('[AudioEngine] 🧟 Event ignored: Not sovereign', { 
              eventSrc: this.audio.src, 
              sovereign: this.sovereignUrl 
          });
          return false;
      }
      return true;
    };

    this.audio.onplay = () => {
      if (!isSovereign()) {
        return;
      }
      console.log('[AudioEngine] 🔊 onplay fired');
      store.patchState({ isPlaying: true, isPaused: false, playbackStalled: false });
    };

    this.audio.onpause = () => {
      if (!isSovereign() && this.intent !== 'STOPPED') {
        return;
      }
      console.log('[AudioEngine] ⏸️ onpause fired');
      store.patchState({ isPaused: true, isPlaying: false, playbackStalled: false });
    };

    this.audio.onwaiting = () => {
      if (!isSovereign()) {
        return;
      }
      console.log('[AudioEngine] ⏳ onwaiting fired');
      if (this.intent === 'PLAYING') {
        store.patchState({ playbackStalled: true });
      }
    };

    this.audio.onplaying = () => {
      if (!isSovereign()) {
        return;
      }
      console.log('[AudioEngine] ▶️ onplaying fired');
      store.patchState({ playbackStalled: false });
    };

    this.audio.onended = () => {
      if (!isSovereign()) {
        return;
      }
      console.log('[AudioEngine] ✅ onended fired → signalling SENTENCE_ENDED');
      const controller = (window as any).__PLAYBACK_CONTROLLER__;
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
        WebviewStore.getInstance().updateUIState({ isAudioContextBlocked: false });
        return;
      } catch (err: any) {
        if (err.name === 'NotAllowedError') {
          console.warn('[AudioEngine] Autoplay blocked, raising shield.');
          WebviewStore.getInstance().updateUIState({ isAudioContextBlocked: true });
        } else {
          console.warn('[AudioEngine] Resume failed', err);
        }
      }
    }
  }

  /**
   * [NEW] Universal Unlocker: Primes the audio subsystem during a user gesture.
   * CALL THIS synchronously in the onClick handler before any async/IPC logic.
   */
  public ensureAudioContext(): boolean {
    // Calling play() on an empty or paused element during a click handler
    // satisfies the browser's user-gesture requirement for the entire session.
    if (this.audio.paused) {
        const p = this.audio.play();
        if (p instanceof Promise) {
            p.then(() => {
                console.log('[AudioEngine] 🔓 Audio subsystem primed via User Gesture');
                WebviewStore.getInstance().updateUIState({ isAudioContextBlocked: false });
            }).catch(() => {
                // Expected failure on empty src, but the "intent" is still registered by browser
            });
        }
        return true;
    }
    return false;
  }

  public prepareForPlayback(): number {
    this.activeIntentId++;
    console.log('[AudioEngine] 🚀 prepareForPlayback', { intentId: this.activeIntentId });
    return this.activeIntentId;
  }

  /**
   * [SOVEREIGNTY] setTarget() - Formalizes the intent to play a specific cacheKey.
   * This is the "Sovereign Intent" that governs UI stalling.
   */
  public setTarget(cacheKey: string | null): void {
    console.log(`[AudioEngine] 🎯 Target set to: ${cacheKey}`);
    this.targetCacheKey = cacheKey;
    
    // If the target is cleared, we should clear stalling as well
    if (!cacheKey) {
      WebviewStore.getInstance().patchState({ playbackStalled: false });
    }
  }

  /**
   * [v2.0.0] Adaptive JIT Wait: Enters a 40ms silent window while waiting for synthesis.
   * If data arrives within 40ms, we play instantly without showing "Loading..." in the UI.
   */
  public startAdaptiveWait(cacheKey: string, intentId: number): Promise<void> {
    if (intentId < this.activeIntentId) {
      console.log('[AudioEngine] ✋ Ignoring stale Synthesis Starting', { intentId, current: this.activeIntentId });
      return Promise.resolve();
    }
    
    // 1. Update active intent
    this.activeIntentId = intentId;
    this.pendingCacheKey = cacheKey;

    // 2. Clean up any existing wait for THIS specific key to avoid overlaps
    this.clearSpecificWait(cacheKey);

    console.log('[AudioEngine] ⏳ Entering Adaptive Wait (40ms)', { cacheKey, intentId });
    
    return new Promise((resolve) => {
      this.waitResolvers.set(cacheKey, resolve);

      const timer = setTimeout(() => {
        // [SOVEREIGNTY]: Only show stall if audio is truly paused AND we are still waiting for THE TARGET.
        const isTarget = cacheKey === this.targetCacheKey;
        if (this.audio.paused && isTarget) {
          console.log('[AudioEngine] ⏳ Adaptive Wait Expired - Showing Loading UI');
          WebviewStore.getInstance().patchState({ playbackStalled: true });
        } else {
          console.log('[AudioEngine] ⏳ Adaptive Wait Expired - Suppressing Loading UI', { 
            paused: this.audio.paused,
            isTarget,
            cacheKey,
            target: this.targetCacheKey
          });
        }
        this.resolveSpecificWait(cacheKey);
      }, 40); // 40ms buffer for Windows IPC jitter

      this.waitTimers.set(cacheKey, timer);
    });
  }

  private clearSpecificWait(cacheKey: string): void {
    const timer = this.waitTimers.get(cacheKey);
    if (timer) {
      clearTimeout(timer);
      this.waitTimers.delete(cacheKey);
    }
    this.resolveSpecificWait(cacheKey);
  }

  private resolveSpecificWait(cacheKey: string): void {
    const resolver = this.waitResolvers.get(cacheKey);
    if (resolver) {
      resolver();
      this.waitResolvers.delete(cacheKey);
    }
  }

  // Legacy support or mass cleanup
  private clearAdaptiveWait(): void {
    for (const key of this.waitTimers.keys()) {
      this.clearSpecificWait(key);
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
    
    // If this is the data we needed, resolve the wait
    if (this.pendingCacheKey === cacheKey) {
        console.log('[AudioEngine] 🔥 JIT Cache Hit via Direct Push - Playing Now', { cacheKey });
        this.clearAdaptiveWait();
        WebviewStore.getInstance().patchState({ playbackStalled: false });
        
        // [CORRECTION] Actually play the blob we just received!
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

    // 3. Graceful Transition: Unload previous buffer and release memory [ISSUE 27]
    this.audio.pause();
    const oldUrl = this.audio.src;
    this.audio.src = '';
    this.audio.load(); // Forces immediate cleanup of the previous track

    if (oldUrl.startsWith('blob:')) {
      this.revokeUrl(oldUrl);
    }

    // [v2.0.7] Immediate memory hygiene
    const url = URL.createObjectURL(blob);
    this.activeObjectURLs.add(url);
    this.sovereignUrl = url;
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
      try {
        await this.audio.play();
        WebviewStore.getInstance().updateUIState({ isAudioContextBlocked: false });
      } catch (err: any) {
        if (err.name === 'NotAllowedError') {
          console.warn('[AudioEngine] 🛡️ Autoplay blocked by browser policy. User gesture required.');
          WebviewStore.getInstance().updateUIState({ isAudioContextBlocked: true });
        } else {
          console.error('[AudioEngine] Playback failed:', err);
        }
      }
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
      this.audio.play().then(() => {
        WebviewStore.getInstance().updateUIState({ isAudioContextBlocked: false });
      }).catch(err => {
        if (err.name === 'NotAllowedError') {
          WebviewStore.getInstance().updateUIState({ isAudioContextBlocked: true });
        } else {
          console.error(err);
        }
      });
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
    this.sovereignUrl = null;
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

  /**
   * [v2.0.6] Atomic Cache Wipe: Revokes all URLs before clearing storage.
   * Prevents "Ghost Audio" from persisting in memory after a cache clear.
   */
  public async wipeCache(): Promise<void> {
    console.log('[AudioEngine] 🌪️ Initiating Atomic Cache Wipe...');
    // 1. Synchronous Revocation (Immediate memory release)
    this.purgeMemory();
    
    // 2. Clear Persistent Storage
    await this.cache.clearAll();
    
    // 3. Reset Store Metrics (Reactive UI parity)
    WebviewStore.getInstance().resetCacheStats();
    
    console.log('[AudioEngine] ✅ Cache wipe complete.');
  }
}
