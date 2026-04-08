import { WebviewStore } from './WebviewStore';
import { AudioEngineEvent, AudioEngineEventType, OutgoingAction } from '../../common/types';
import { CacheManager } from '../cacheManager';
import { MessageClient } from './MessageClient';

/**
 * WebviewAudioEngine: Simplified "Dumb Player" Worker (v2.3.1)
 * [AUTORADIANT]: Decommissioned AudioStrategy pattern. Unified synthesis pipe.
 * passive worker that executes commands from the Extension (Extension handles health).
 */
export class WebviewAudioEngine {
  private static instance: WebviewAudioEngine;
  private _audio: HTMLAudioElement;
  private get _speechSynth(): SpeechSynthesis { return window.speechSynthesis; }
  private _utterance: SpeechSynthesisUtterance | null = null;
  private _isPrimed: boolean = false;
  
  public onEvent?: (event: AudioEngineEvent) => void;
  public instanceId: number = Math.random();
  
  public activeIntentId: number = 0;
  private playbackMutex: Promise<void> = Promise.resolve();
  private pendingResolvers: Set<() => void> = new Set();
  private intentCounter: number = 0;
  private activeLockResolver: (() => void) | null = null;
  private activePlaybackResolver: (() => void) | null = null;
  private _activeObjectURLs: Set<string> = new Set();

  public constructor() {
    this._audio = new Audio();
    this.activeIntentId = 0;
    this.setupAudioListeners();
    this.setupStoreListeners();
  }

  public static getInstance(): WebviewAudioEngine {
    if (!this.instance) {
      this.instance = new WebviewAudioEngine();
      if (typeof window !== 'undefined') {
        (window as any).__AUDIO_ENGINE__ = this.instance;
      }
    }
    return this.instance;
  }

  public static resetInstance(): void {
    if (this.instance) {
      this.instance.stop('reset');
      this.instance.dispose();
    }
    this.instance = undefined as any;
  }

  // Testability & Visibility
  public isBusy(): boolean {
    return this.pendingResolvers.size > 0;
  }

  public get audioElement(): HTMLAudioElement {
    return this._audio;
  }

  private setupAudioListeners(): void {
    this._audio.onplay = () => this.emit(AudioEngineEventType.PLAYING);
    this._audio.onpause = () => this.emit(AudioEngineEventType.PAUSED);
    this._audio.onended = () => this.emit(AudioEngineEventType.ENDED);
    this._audio.onerror = (e) => this.emit(AudioEngineEventType.ERROR, `Audio Error: ${this._audio.error?.message || 'Unknown'}`);
    this._audio.onwaiting = () => this.emit(AudioEngineEventType.BUFFERING);
    this._audio.onstalled = () => this.emit(AudioEngineEventType.STALLED);
  }

  private setupStoreListeners(): void {
    const store = WebviewStore.getInstance();
    store.subscribe((s) => s.volume, (v) => this.setVolume(v));
    store.subscribe((s) => s.rate, (v) => this.setRate(v));
    store.subscribe((s) => s.isPaused, (p) => p ? this.pause() : this.resume());

    let lastPlaying = store.getState().isPlaying;
    store.subscribe((s) => s.isPlaying, (playing) => { 
      if (lastPlaying === true && playing === false) {
        this.stop('infinity');
      }
      lastPlaying = playing;
    });
  }

  private emit(type: AudioEngineEventType, message?: string): void {
    this.onEvent?.({ type, message, intentId: this.activeIntentId });
  }

   /**
   * [v2.3.1] Simplified Lock Mechanism
   * Ensures serial execution of playback actions.
   */
  public async acquireLock(intentId?: number): Promise<(() => void) | null> {
    console.log(`[AUDIO] 🔒 AcquireLock Start: intent=${intentId}, active=${this.activeIntentId}`);
    // 1. Pre-lock Verifcation
    if (intentId !== undefined && intentId < this.activeIntentId) {
        console.warn(`[AUDIO] 🧟 Intent Rejected (Pre-Lock): ${intentId} < ${this.activeIntentId}`);
        return null;
    }

    // 2. Intent Sovereignty
    if (intentId !== undefined && intentId > this.activeIntentId) {
      console.log(`[AUDIO] 🚀 New Intent: ${intentId} (Busting ${this.activeIntentId})`);
      this.activeIntentId = intentId;
      this.stop('none'); 
    }

    const previousMutex = this.playbackMutex;
    let resolveNext: (() => void) | undefined;
    
    this.playbackMutex = new Promise<void>(resolve => { resolveNext = resolve; });
    this.pendingResolvers.add(resolveNext!);
    this.activeLockResolver = resolveNext; // [v2.3.1] Track active lock

    try {
      console.log(`[AUDIO] ⏳ Waiting for Mutex: intent=${intentId}`);
      
      // [SOVEREIGNTY] 4s Safety Watchdog (v2.3.1)
      // Prevents "Zombie Locks" from freezing the entire engine
      await Promise.race([
          previousMutex,
          new Promise(r => setTimeout(() => {
              console.warn(`[AUDIO] ⚠️ Mutex Wait Watchdog triggered for intent=${intentId}`);
              r(null);
          }, 4000))
      ]);
      
      console.log(`[AUDIO] ✅ Mutex Acquired: intent=${intentId}`);
      
      // 3. Post-lock Verification
      if (intentId !== undefined && intentId < this.activeIntentId) {
          console.warn(`[AUDIO] 🧟 Intent Rejected (Post-Lock): ${intentId} < ${this.activeIntentId}`);
          this.pendingResolvers.delete(resolveNext!);
          if (this.activeLockResolver === resolveNext) {this.activeLockResolver = null;}
          resolveNext!();
          return null;
      }

      // 4. Update authority
      const finalIntent = intentId ?? ++this.intentCounter;
      if (finalIntent > this.activeIntentId) {
        this.activeIntentId = finalIntent;
      }

      return () => {
        this.pendingResolvers.delete(resolveNext!);
        if (this.activeLockResolver === resolveNext) {this.activeLockResolver = null;}
        resolveNext!();
      };
    } catch (e) {
      console.warn(`[AUDIO] Lock Acquisition Failed: ${e instanceof Error ? e.message : 'Unknown'}`);
      this.pendingResolvers.delete(resolveNext!);
      if (this.activeLockResolver === resolveNext) {this.activeLockResolver = null;}
      resolveNext!();
      return null;
    }
  }

  public ensureAudioContext(): void {
    if (this._isPrimed) {return;}
    this._audio.muted = true;
    this._audio.play().then(() => {
      this._isPrimed = true;
      this._audio.muted = false;
      console.log('[AUDIO] 🔓 Primed');
    }).catch(() => {});
  }

  public async playBlob(blob: Blob, key: string, intentId?: number): Promise<void> {
    const release = await this.acquireLock(intentId);
    if (release === null) { return; }

    try {
        await new Promise<void>((resolve) => {
            const url = URL.createObjectURL(blob);
            this._activeObjectURLs.add(url);
            this._audio.src = url;
            
            const cleanup = () => {
                this._audio.removeEventListener('ended', onEnded);
                this._audio.removeEventListener('error', onError);
                URL.revokeObjectURL(url);
                if (this.activePlaybackResolver === resolve) {this.activePlaybackResolver = null;}
            };

            this.activePlaybackResolver = resolve; // [v2.3.1] Initial tracker

            const onEnded = () => {
                cleanup();
                resolve();
            };
            
            const onError = () => {
                cleanup();
                this.emit(AudioEngineEventType.ERROR, `Playback Error: ${key}`);
                resolve();
            };
            
            this._audio.addEventListener('ended', onEnded);
            this._audio.addEventListener('error', onError);
            
            // Authoritative Cancellation
            const cancel = () => {
                this._audio.pause();
                console.log(`[AUDIO] 🛑 Authoritative Cancellation triggered: intent=${intentId}`);
                onEnded();
            };
            this._audio.play().catch(e => {
                if (e.name !== 'AbortError') {
                    this.emit(AudioEngineEventType.ERROR, e.message);
                }
                onEnded();
            });

            // [SOVEREIGNTY] Safety Watchdog (v2.3.1)
            // Ensure tests and production never hang forever if JSDOM/Hardware events fail
            setTimeout(() => {
                if (this.activePlaybackResolver === cancel || this.activePlaybackResolver === resolve) {
                    console.warn(`[AUDIO] Watchdog resolved hanging playBlob (intent=${intentId})`);
                    onEnded();
                }
            }, 3000); // 3s for test compatibility (v2.3.1)
        });
    } finally {
        release();
    }
  }

  public async playFromBase64(base64: string, cacheKey?: string, intentId?: number): Promise<void> {
    try {
        const response = await fetch(`data:audio/mpeg;base64,${base64}`);
        const blob = await response.blob();
        await this.playBlob(blob, cacheKey || 'temp', intentId);
    } catch (e: any) {
        this.emit(AudioEngineEventType.ERROR, e.message);
    }
  }

  public async playFromCache(cacheKey: string, intentId?: number): Promise<void> {
      try {
          const blob = await CacheManager.getInstance().get(cacheKey);
          if (blob) {
              await this.playBlob(blob, cacheKey, intentId);
          } else {
              this.emit(AudioEngineEventType.ERROR, `Cache Miss: ${cacheKey}`);
          }
      } catch (e: any) {
          this.emit(AudioEngineEventType.ERROR, e.message);
      }
  }

  /**
   * speakLocal (Renamed from synthesize to reflect purpose)
   */
  public async speakLocal(text: string, voiceId?: string, intentId?: number): Promise<void> {
    const release = await this.acquireLock(intentId);
    if (release === null) { return; }

    try {
        await new Promise<void>((resolve) => {
            this.stopLocal();
            this._utterance = new SpeechSynthesisUtterance(text);
            
            if (voiceId) {
              const available = this._speechSynth.getVoices();
              const target = available.find(v => v.voiceURI === voiceId || v.name === voiceId);
              if (target) {this._utterance.voice = target;}
            }

            const state = WebviewStore.getInstance().getState();
            this._utterance.rate = 1 + (state.rate / 10);
            this._utterance.volume = state.volume / 100;

            const cleanup = () => {
                if (this._utterance) {
                    this._utterance.onstart = null;
                    this._utterance.onend = null;
                    this._utterance.onerror = null;
                }
                if (this.activePlaybackResolver === resolve) {this.activePlaybackResolver = null;}
            };

            this.activePlaybackResolver = resolve; // [v2.3.1] Wire up for stop()

            const onEnd = () => {
                cleanup();
                resolve();
            };

            this._utterance.onstart = () => this.emit(AudioEngineEventType.PLAYING);
            this._utterance.onend = onEnd;
            this._utterance.onerror = (e) => {
                cleanup();
                this.emit(AudioEngineEventType.ERROR, `Local Error: ${e.error}`);
                onEnd();
            };

            // Authoritative Cancellation Hook
            this.activePlaybackResolver = () => {
                this.stopLocal();
                console.log(`[AUDIO] 🛑 Authoritative Cancellation triggered (Synthesis): intent=${intentId}`);
                onEnd();
            };

            this._speechSynth.speak(this._utterance);
        });
    } finally {
        release();
    }
  }

  /**
   * [v2.2.1] Atomic Ingestion
   */
  public async ingestData(cacheKey: string, base64: string, intentId: number): Promise<void> {
    if (intentId < this.activeIntentId) {return;}
    try {
        const response = await fetch(`data:application/octet-stream;base64,${base64}`);
        const blob = await response.blob();
        await CacheManager.getInstance().set(cacheKey, blob);
    } catch (e) {
        console.error(`[AUDIO] ❌ Ingestion failed for ${cacheKey}:`, e);
    }
  }

  public async wipeCache(): Promise<void> {
    this.stop('none'); // Ensure active blob URLs are revoked via cleanup
    await CacheManager.getInstance().clearAll();
  }

  public purgeMemory(): void {
    this.stop();
  }

  public pause(): void {
    this._audio.pause();
    this._speechSynth.pause();
  }

  public resume(): void {
    if (this._utterance) {
      this._speechSynth.resume();
    } else {
      this._audio.play().catch(() => {});
    }
  }

  public stop(mode: 'infinity' | 'reset' | 'none' | boolean = 'reset'): void {
    // legacy boolean support
    let targetMode = mode;
    if (mode === true) {targetMode = 'reset';}
    if (mode === false) {targetMode = 'infinity';}

    console.log(`[AUDIO] 🛑 Stop requested (Mode: ${targetMode})`);

    this._audio.pause();
    this._audio.src = '';
    
    // [v2.3.1] Ghost Audio Guard: Explicitly revoke all tracked blob URLs
    this._activeObjectURLs.forEach(url => URL.revokeObjectURL(url));
    this._activeObjectURLs.clear();

    this.stopLocal();
    
    // [v2.3.1] Force-resolve ALL potential blockers
    if (this.activeLockResolver) {
        this.activeLockResolver();
        this.activeLockResolver = null;
    }
    if (this.activePlaybackResolver) {
        this.activePlaybackResolver();
        this.activePlaybackResolver = null;
    }

    this.pendingResolvers.forEach(resolve => resolve());
    this.pendingResolvers.clear();

    if (targetMode !== 'none') {
      this.playbackMutex = Promise.resolve();
    }

    if (targetMode === 'infinity') {
      this.activeIntentId = Infinity;
    } else if (targetMode === 'reset') {
      this.activeIntentId = 0;
    }
  }

  private stopLocal(): void {
    this._speechSynth.cancel();
    this._utterance = null;
  }

  public setVolume(val: number): void {
    this._audio.volume = Math.max(0, Math.min(1, val / 100));
    if (this._utterance) {this._utterance.volume = val / 100;}
  }

  public setRate(val: number): void {
    this._audio.playbackRate = 1 + (val / 10);
    if (this._utterance) {this._utterance.rate = 1 + (val / 10);}
  }

  public scanVoices(): void {
    const voices = this._speechSynth.getVoices();
    if (voices.length > 0) {
      const report = voices.map(v => ({
        name: v.name,
        id: v.voiceURI,
        lang: v.lang,
        engine: 'local'
      }));
      MessageClient.getInstance().postAction(OutgoingAction.REPORT_VOICES, { voices: report });
    }
  }

  public dispose(): void {
    this.stop();
    if (typeof this._audio.remove === 'function') {
      this._audio.remove();
    } else {
      this._audio.pause();
      this._audio.src = '';
    }
  }
}
