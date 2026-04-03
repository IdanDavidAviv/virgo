import { MessageClient } from './MessageClient';
import { OutgoingAction, IncomingCommand } from '../../common/types';
import { CacheManager } from '../cacheManager';
import { ToastManager } from '../components/ToastManager';
import { WebviewStore } from './WebviewStore';

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
  private intent: 'PLAYING' | 'STOPPED' | 'PAUSED' = 'STOPPED';
  private isAwaitingSync: boolean = false;
  private currentSequenceId: number = 0;
  private syncTimeout: any = null;

  private constructor() {
    this.audio = new Audio();
    this.audio.id = 'neural-player';
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
    this.audio.onended = () => {
      console.log('[AudioEngine] ✅ onended fired → signalling SENTENCE_ENDED');
      this.intent = 'STOPPED';
      MessageClient.getInstance().postAction(OutgoingAction.SENTENCE_ENDED);
    };

    this.audio.onerror = (e) => {
      const msg = `[AudioEngine] ⛔ Audio element error: ${(e as ErrorEvent).message ?? 'unknown playback failure'}`;
      console.error(msg);
      this.releaseLock();
      MessageClient.getInstance().postAction(OutgoingAction.ERROR, { message: msg });
    };

    this.audio.onplay = () => {
      console.log('[AudioEngine] ▶️ Playback started');
      this.intent = 'PLAYING';
      this.releaseLock();
      
      // Update store state
      WebviewStore.getInstance().patchState({ 
        isPlaying: true, 
        isPaused: false,
        playbackStalled: false 
      });
    };

    this.audio.onpause = () => {
        if (this.intent === 'STOPPED') {
          return;
        }
        WebviewStore.getInstance().patchState({ isPaused: true });
    };

    this.audio.onwaiting = () => {
        console.warn('[AudioEngine] ⏳ Audio element is waiting/stalled (Buffer Underflow)');
        WebviewStore.getInstance().patchState({ playbackStalled: true });
        
        // Auto-recovery: If stalled for more than 5s while playing, try a soft resume
        setTimeout(() => {
            if (this.audio.paused === false && this.audio.readyState < 3 && this.intent === 'PLAYING') {
                console.warn('[AudioEngine] 🛸 Stall detected for 5s, attempting soft resume...');
                this.audio.pause();
                this.audio.play().catch(e => console.error('[AudioEngine] Recovery failed:', e));
            }
        }, 5000);
    };

    // 2. [REACTIVE] Real-time settings synchronization
    const store = WebviewStore.getInstance();
    store.subscribe((s) => s.volume, (vol) => {
        this.setVolume(vol);
    });
    store.subscribe((s) => s.rate, (rate) => {
        this.setRate(rate);
    });
  }

  /**
   * High-level play command. 
   * Intelligently decides between resuming local audio or requesting new synthesis from host.
   */
  /**
   * High-level play command. 
   * Intelligently decides between resuming local audio, playing from cache, or requesting synthesis.
   */
  public async play(intent: string = 'USER_CLICK'): Promise<void> {
    console.log(`[AudioEngine] play() requested | Intent: ${intent} | src: ${!!this.audio.src} | paused: ${this.audio.paused}`);

    // Authoritative Intent: We are now playing (even if audio hasn't arrived yet)
    this.intent = 'PLAYING';

    // 1. If we have active audio and it's just paused, resume it.
    if (this.audio.src && this.audio.paused && !this.audio.ended) {
      try {
        await this.audio.play();
        return;
      } catch (err) {
        console.warn('[AudioEngine] Resume failed, falling back to full LOAD_AND_PLAY', err);
      }
    }

    // 2. Local-First Check: If we have this sentence in cache, play it IMMEDIATELY.
    const store = WebviewStore.getInstance();
    const key = store.getSentenceKey();
    if (key) {
        const hit = await this.playFromCache(key);
        if (hit) {
            console.log(`[AudioEngine] ⚡ Zero-Latency Playback: Local-First strike for ${key}`);
            return;
        }
    }

    // 3. Otherwise, request new audio from the extension host.
    this.prepareForPlayback();
    MessageClient.getInstance().postAction(OutgoingAction.LOAD_AND_PLAY, { intent });
  }

  /**
   * Prepares the engine for a new playback request.
   * Sets intent, increments sequence, and acquires the sync lock.
   */
  public prepareForPlayback(): number {
    this.currentSequenceId++;
    console.log('[AudioEngine] 🚀 prepareForPlayback', { sequenceId: this.currentSequenceId, intent: 'PLAYING' });
    this.intent = 'PLAYING';
    this.acquireLock();
    return this.currentSequenceId;
  }

  /**
   * Acquires the "Sync Lock", preventing duplicate requests and showing loading states.
   */
  public acquireLock(): void {
    this.isAwaitingSync = true;
    WebviewStore.getInstance().updateUIState({ isAwaitingSync: true });

    // Watchdog: Clear lock if host doesn't respond in 3.5s
    if (this.syncTimeout) { clearTimeout(this.syncTimeout); }
    this.syncTimeout = setTimeout(() => {
      if (this.isAwaitingSync) {
        console.warn('[AudioEngine] ⏳ Sync Watchdog Fired: Host unresponsive for 3.5s');
        this.releaseLock();
      }
    }, 3500);
  }

  public releaseLock(): void {
    this.isAwaitingSync = false;
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    WebviewStore.getInstance().updateUIState({ isAwaitingSync: false });
  }

  /**
   * Plays audio from a base64 string and optionally saves it to the cache.
   */
  public async playFromBase64(base64: string, cacheKey?: string, sequenceId?: number): Promise<void> {
    console.log('[AudioEngine] playFromBase64 called', { instanceId: this.instanceId, cacheKey, sequenceId, intent: this.intent });
    try {
      // Capture desired intent before stop() resets it. 
      // If we are currently STOPPED, we intend to start playing now.
      const savedIntent = (this.intent === 'PAUSED') ? 'PAUSED' : 'PLAYING';
      
      this.stop(); 
      this.intent = savedIntent; 

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

      await this.playBlob(blob, sequenceId);
    } catch (err) {
      console.error('[AudioEngine] Failed to play base64 audio:', err);
    }
  }

  /**
   * Plays audio directly from the IndexedDB cache.
   */
  public async playFromCache(cacheKey: string): Promise<boolean> {
    try {
      const blob = await this.cache.get(cacheKey);
      if (blob) {
        const savedIntent = this.intent === 'PAUSED' ? 'PAUSED' : 'PLAYING';
        this.stop();
        this.intent = savedIntent; 
        await this.playBlob(blob);
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

  public async playBlob(blob: Blob, sequenceId?: number): Promise<void> {
    // 1. Sequence Guard: If this is an old request, ignore it.
    if (sequenceId !== undefined && sequenceId < this.currentSequenceId) {
        console.warn(`[AudioEngine] 🧟 Ignoring Zombie Audio (Sequence mismatch: ${sequenceId} < ${this.currentSequenceId})`);
        return;
    }

    // 2. Intent Guard: If user stopped while we were synthesizing, ignore the audio.
    if (this.intent === 'STOPPED') {
      console.log('[AudioEngine] 🧟 Ignoring Zombie Audio (Intent was STOPPED)');
      this.releaseLock();
      return;
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
    // If PAUSED, we leave it loaded in src for immediate resume.
    if (this.intent === 'PLAYING') {
      await this.audio.play();
    }
  }

  public pause(): void {
    this.intent = 'PAUSED';
    this.audio.pause();
    this.releaseLock();
  }

  public resume(): void {
    this.intent = 'PLAYING';
    if (this.audio.src) {
      this.audio.play().catch(console.error);
    }
  }

  public stop(): void {
    console.log('[AudioEngine] ⏹️ Stop requested (Intent → STOPPED)');
    this.intent = 'STOPPED';
    this.audio.pause();
    this.audio.currentTime = 0;
    this.releaseLock();
    
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

  /**
   * Returns current internal intent (PLAYING vs STOPPED)
   */
  public getIntent(): 'PLAYING' | 'STOPPED' | 'PAUSED' {
    return this.intent;
  }
}
