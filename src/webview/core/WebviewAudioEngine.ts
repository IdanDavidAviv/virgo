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
  private _lockOwnerIntentId: number | null = null;

  /** [SOVEREIGNTY] Authoritative Playback Mutex */
  private playbackMutex: Promise<void> = Promise.resolve();
  private pendingResolvers: Set<() => void> = new Set();
  private _localSequence: number = 0;
  private activeSequence: number = 0;
  private activeLockResolver: (() => void) | null = null;
  private activePlaybackResolver: (() => void) | null = null;
  private _activeObjectURLs: Set<string> = new Set();
  private _abortController: AbortController | null = null;

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
      this.instance.stop();
      this.instance.dispose();
    }
    this.instance = undefined as any;
  }

  // Testability & Visibility
  public isBusy(): boolean {
    return this.pendingResolvers.size > 0;
  }

  /**
   * [v2.3.1] Synchronous Tier-1 check.
   * Required for fast predictive synthesis logic.
   */
  public isSegmentReady(key: string): boolean {
    return CacheManager.getInstance().isCachedLocally(key);
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
        this.stop();
      }
      lastPlaying = playing;
    });
  }

  private emit(type: AudioEngineEventType, message?: string): void {
    this.onEvent?.({ type, message, intentId: this.activeIntentId });
  }

   /**
   * [v2.3.1] Simplified Lock Mechanism (Abortable)
   * Ensures serial execution of playback actions with authoritative cancellation.
   */
  public async acquireLock(intentId?: number): Promise<(() => void) | null> {
    console.log(`[AUDIO] 🔒 AcquireLock Start: intent=${intentId}, active=${this.activeIntentId}`);
    
    // 1. Intent Sovereignty & Preemption
    const isNewIntent = intentId !== undefined && intentId > this.activeIntentId;
    
    if (isNewIntent) {
      console.log(`[AUDIO] 🔥 Sovereign Preemption: ${intentId} > ${this.activeIntentId} (Instance=${this.instanceId})`);
      this.stop(); // Authoritative reset - also resets playbackMutex to resolved
      this.activeIntentId = intentId!;
      this._abortController = new AbortController();
      this.activeSequence = ++this._localSequence;
    } else if (intentId !== undefined && intentId < this.activeIntentId) {
        console.warn(`[AUDIO] 🧟 Stale Intent Rejected: ${intentId} < ${this.activeIntentId} (Instance=${this.instanceId})`);
        return null;
    } else if (this._abortController === null) {
      this._abortController = new AbortController();
    }

    const currentSequence = this.activeSequence;
    const currentAbortSignal = this._abortController?.signal;
    
    // [SOVEREIGNTY] Capture mutex AFTER potential preemption reset
    const previousMutex = this.playbackMutex; 
    let resolveNext: (() => void) | undefined;
    this.playbackMutex = new Promise<void>(resolve => {
      resolveNext = resolve;
    });
    this.pendingResolvers.add(resolveNext!);

    try {
      console.log(`[AUDIO] ⏳ Waiting for Mutex: intent=${intentId} (Currently held by: ${this._lockOwnerIntentId}, Instance=${this.instanceId})`);
      
      let watchdog: any;
      
      // [SOVEREIGNTY] Authoritative Wait with Safety Watchdog
      await Promise.race([
          previousMutex.catch(() => {}), // Ignore previous errors
          new Promise((_, reject) => {
              if (currentAbortSignal?.aborted) {
                  return reject(new Error('Aborted'));
              }
              currentAbortSignal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
          }),
          new Promise(r => {
              watchdog = setTimeout(() => {
                  console.warn(`[AUDIO] ⚠️ Mutex Safety Timeout (intent=${intentId}, waiting for=${this._lockOwnerIntentId}, Instance=${this.instanceId})`);
                  r(null);
              }, 3000);
          })
      ]);
      
      if (watchdog) {clearTimeout(watchdog);}
      
      // 2. Post-lock Verification
      // If we were preempted WHILE waiting, we must discard this lock and pass it forward.
      if (currentSequence !== this.activeSequence || (currentAbortSignal && currentAbortSignal.aborted)) {
          console.warn(`[AUDIO] 🧟 Intent Discarded (Post-Lock): intent=${intentId} (Instance=${this.instanceId})`);
          this.pendingResolvers.delete(resolveNext!);
          resolveNext!();
          return null;
      }

      this._lockOwnerIntentId = intentId ?? -1;
      console.log(`[AUDIO] ✅ Mutex Acquired: intent=${intentId} (Instance=${this.instanceId})`);
      
      return () => {
        if (this._lockOwnerIntentId === (intentId ?? -1)) {
            this._lockOwnerIntentId = null;
        }
        this.pendingResolvers.delete(resolveNext!);
        resolveNext!();
      };
    } catch (err: any) {
      console.warn(`[AUDIO] 🔒 Lock Failed: ${err.message} (intent=${intentId})`);
      this.pendingResolvers.delete(resolveNext!);
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

    const signal = this._abortController?.signal;

    try {
        if (signal?.aborted) { return; }

        await new Promise<void>((resolve) => {
            const url = URL.createObjectURL(blob);
            this._activeObjectURLs.add(url);
            this._audio.src = url;
            
            let isResolved = false;
            let playWatchdog: any;

            const finish = (reason: string) => {
                if (isResolved) {return;}
                isResolved = true;
                
                if (playWatchdog) {clearTimeout(playWatchdog);}
                this._audio.removeEventListener('ended', onEnded);
                this._audio.removeEventListener('error', onError);
                if (signal) { signal.removeEventListener('abort', onAborted); }
                
                URL.revokeObjectURL(url);
                if (this.activePlaybackResolver === resolve) { this.activePlaybackResolver = null; }
                
                // console.log(`[AUDIO] 🏁 Play finished (reason=${reason}, intent=${intentId})`);
                resolve();
            };

            const onEnded = () => finish('ended');
            const onError = (e: any) => {
                this.emit(AudioEngineEventType.ERROR, `Playback Error: ${intentId}`);
                finish('error');
            };
            const onAborted = () => {
                this._audio.pause();
                finish('abort');
            };
            
            this._audio.addEventListener('ended', onEnded);
            this._audio.addEventListener('error', onError);
            if (signal) {
                if (signal.aborted) { onAborted(); return; }
                signal.addEventListener('abort', onAborted, { once: true });
            }
            
            this._audio.play()
                .catch(e => {
                    if (e.name !== 'AbortError') {
                        console.error(`[AUDIO] ❌ Play Rejected: intent=${intentId}`, e);
                    }
                    finish('reject');
                });

            this.activePlaybackResolver = resolve;
            playWatchdog = setTimeout(() => {
                finish('watchdog');
            }, 3000); // 3s safety fallback
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

  public async playFromCache(cacheKey: string, intentId?: number): Promise<boolean> {
      try {
          const blob = await CacheManager.getInstance().get(cacheKey);
          if (blob) {
              await this.playBlob(blob, cacheKey, intentId);
              return true;
          } else {
              return false;
          }
      } catch (e: any) {
          this.emit(AudioEngineEventType.ERROR, e.message);
          return false;
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
   * [v2.3.2] Strict Baton Floor Enforcement
   */
  public async ingestData(cacheKey: string, base64: string, intentId: number): Promise<void> {
    if (intentId < this.activeIntentId && this.activeIntentId !== 0) {
        console.warn(`[AUDIO] 🧟 Rejecting stale ingestion: ${intentId} < ${this.activeIntentId}`);
        return;
    }
    try {
        const response = await fetch(`data:application/octet-stream;base64,${base64}`);
        const blob = await response.blob();
        await CacheManager.getInstance().set(cacheKey, blob);
    } catch (e) {
        console.error(`[AUDIO] ❌ Ingestion failed for ${cacheKey}:`, e);
    }
  }

  public async wipeCache(): Promise<void> {
    this.stop();
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

  public stop(): void {
    const count = this.pendingResolvers.size;
    console.log(`[AUDIO] 🛑 Stop triggered: intent=${this.activeIntentId} (Instance=${this.instanceId}, Resolvers=${count})`);

    this._abortController?.abort();
    this._abortController = null;
    
    this._audio.pause();
    this._audio.src = '';
    
    this._activeObjectURLs.forEach(url => URL.revokeObjectURL(url));
    this._activeObjectURLs.clear();

    this.stopLocal();
    
    // Force-resolve ALL potential blockers
    this.pendingResolvers.forEach(resolve => resolve());
    this.pendingResolvers.clear();

    this.playbackMutex = Promise.resolve();
    this.activeIntentId = 0;
    this._lockOwnerIntentId = null;
    this.activeSequence = 0;
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
