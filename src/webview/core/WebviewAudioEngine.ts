import { WebviewStore } from './WebviewStore';
import { AudioEngineEvent, AudioEngineEventType, OutgoingAction } from '../../common/types';
import { CacheManager } from '../cacheManager';
import { MessageClient } from './MessageClient';

/**
 * WebviewAudioEngine: Simplified "Dumb Player" Worker (v2.3.2)
 * [AUTORADIANT]: Decommissioned AudioStrategy pattern. Unified synthesis pipe.
 * passive worker that executes commands from the Extension.
 */
export class WebviewAudioEngine {
  private static instance: WebviewAudioEngine;
  private _audio: HTMLAudioElement;
  private get _speechSynth(): SpeechSynthesis { return window.speechSynthesis; }
  private _utterance: SpeechSynthesisUtterance | null = null;
  private _isPrimed: boolean = false;
  
  // [RATE_SOVEREIGNTY] 🎯 v2.3.2
  // Stores the original synthesis rate of the neural audio segment.
  // Used to calculate: effectiveRate = targetRate / bakedRate.
  private bakedRate: number = 1.0;
  
  public onEvent?: (event: AudioEngineEvent) => void;
  public instanceId: number = Math.random();
  
  public activeIntentId: number = 0;
  private _lockOwnerIntentId: number | null = null;

  /** [SOVEREIGNTY] Authoritative Playback Mutex */
  private playbackMutex: Promise<void> = Promise.resolve();
  private pendingResolvers: Set<() => void> = new Set();
  private _localSequence: number = 0;
  private activeSequence: number = 0;
  private _abortController: AbortController | null = null;
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
      this.instance.stop();
      this.instance.dispose();
    }
    this.instance = undefined as any;
  }

  public isBusy(): boolean {
    return this.pendingResolvers.size > 0;
  }

  public isSegmentReady(key: string): boolean {
    return CacheManager.getInstance().isCachedLocally(key);
  }

  public get audioElement(): HTMLAudioElement {
    return this._audio;
  }

  private setupAudioListeners(): void {
    this._audio.addEventListener('play', () => this.emit(AudioEngineEventType.PLAYING));
    this._audio.addEventListener('pause', () => this.emit(AudioEngineEventType.PAUSED));
    this._audio.addEventListener('ended', () => this.emit(AudioEngineEventType.ENDED));
    this._audio.addEventListener('error', () => {
        const errorMsg = `Audio Error: ${this._audio.error?.message || 'Unknown'} (Code: ${this._audio.error?.code})`;
        console.error(`[AUDIO] ❌ ${errorMsg}`);
        this.emit(AudioEngineEventType.ERROR, errorMsg);
    });
    this._audio.addEventListener('waiting', () => this.emit(AudioEngineEventType.BUFFERING));
    this._audio.addEventListener('stalled', () => this.emit(AudioEngineEventType.STALLED));
    this._audio.addEventListener('loadstart', () => console.log('[AUDIO] 🏁 loadstart'));
    this._audio.addEventListener('canplay', () => console.log('[AUDIO] ✅ canplay'));
  }

  private setupStoreListeners(): void {
    const store = WebviewStore.getInstance();
    store.subscribe((s) => s.volume, (v) => {
      console.log(`[VOL_TRACE] 📡 Store→Engine subscription fired | val=${v} | mode=${store.getState().engineMode}`);
      this.setVolume(v);
    });
    store.subscribe((s) => s.rate, (v) => {
      console.log(`[RATE_TRACE] 📡 Store→Engine subscription fired | val=${v} | mode=${store.getState().engineMode}`);
      this.setRate(v);
    });
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

  public async acquireLock(intentId?: number): Promise<(() => void) | null> {
    const isNewIntent = intentId !== undefined && intentId > this.activeIntentId;
    
    if (isNewIntent) {
      this.stop(); 
      this.activeIntentId = intentId!;
      this._abortController = new AbortController();
      this.activeSequence = ++this._localSequence;
    } else if (intentId !== undefined && intentId < this.activeIntentId) {
        return null;
    } else if (this._abortController === null) {
      this._abortController = new AbortController();
    }

    const currentSequence = this.activeSequence;
    const currentAbortSignal = this._abortController?.signal;
    
    const previousMutex = this.playbackMutex; 
    let resolveNext: (() => void) | undefined;
    this.playbackMutex = new Promise<void>(resolve => {
      resolveNext = resolve;
    });
    this.pendingResolvers.add(resolveNext!);

    try {
      let watchdog: any;
      await Promise.race([
          previousMutex,
          new Promise((_, reject) => {
              if (currentAbortSignal?.aborted) { return reject(new Error('Aborted')); }
              currentAbortSignal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
          }),
          new Promise(r => {
              watchdog = setTimeout(() => {
                  console.warn(`[AUDIO] ⚠️ Mutex Safety Timeout (intent=${intentId})`);
                  r(null);
              }, 3000);
          })
      ]);
      
      if (watchdog) {clearTimeout(watchdog);}
      
      if (currentSequence !== this.activeSequence || (currentAbortSignal && currentAbortSignal.aborted)) {
          this.pendingResolvers.delete(resolveNext!);
          resolveNext!();
          return null;
      }

      this._lockOwnerIntentId = intentId ?? -1;
      return () => {
        if (this._lockOwnerIntentId === (intentId ?? -1)) { this._lockOwnerIntentId = null; }
        this.pendingResolvers.delete(resolveNext!);
        resolveNext!();
      };
    } catch (err: any) {
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

  public async playBlob(blob: Blob, key: string, intentId?: number, bakedRate?: number): Promise<void> {
    const release = await this.acquireLock(intentId);
    if (release === null) { return; }

    // [RATE_TRACKING] Capture segment synthesis rate for relative adjustments.
    if (bakedRate !== undefined) {
        this.bakedRate = bakedRate;
    }

    const signal = this._abortController?.signal;

    try {
        if (signal?.aborted) { return; }

        await new Promise<void>((resolve) => {
            const url = URL.createObjectURL(blob);
            this._activeObjectURLs.add(url);
            
            let isResolved = false;
            let playWatchdog: any;

            const finish = (reason: string) => {
                if (isResolved) {return;}
                isResolved = true;
                if (playWatchdog) {clearTimeout(playWatchdog);}
                this._audio.removeEventListener('ended', onEnded);
                this._audio.removeEventListener('error', onError);
                this._audio.removeEventListener('canplay', onCanPlay);
                if (signal) { signal.removeEventListener('abort', onAborted); }
                URL.revokeObjectURL(url);
                resolve();
            };

            const onCanPlay = () => {
                const state = WebviewStore.getInstance().getState();
                
                // [SEAMLESS_RATE] Apply relative rate before starting playback.
                this._applyPlaybackRate();

                console.log(`[RATE_TRACE] 🔊 Neural canplay | playbackRate=${this._audio.playbackRate.toFixed(2)} | store.rate=${state.rate} | baked=${this.bakedRate} | vol=${this._audio.volume} | mode=${state.engineMode}`);
                this._audio.play().catch(e => {
                    if (e.name === 'NotAllowedError') {
                        // [AUTOPLAY GUARD] Browser blocked play() — no user gesture yet.
                        // Rollback the store immediately to prevent phantom isPlaying:true state.
                        console.warn(`[AUDIO] 🚫 Autoplay blocked for: ${key}. Rolling back store.`);
                        WebviewStore.getInstance().patchState({ isPlaying: false, isPaused: false });
                        // [PROPAGATION] Notify extension so its StateStore stays in sync.
                        // without this the next UI_SYNC would overwrite the rollback with isPlaying:true.
                        try {
                            (window as any).vscode?.postMessage({ command: 'PLAYBACK_BLOCKED', cacheKey: key });
                        } catch (_) { /* webview sandbox — non-fatal */ }
                    } else if (e.name !== 'AbortError') {
                        console.error(`[AUDIO] ❌ Play Failed: ${key}`, e);
                    }
                    finish('reject');
                });
            };

            const onEnded = () => finish('ended');
            const onError = () => finish('error');
            const onAborted = () => { this._audio.pause(); finish('abort'); };
            
            this._audio.addEventListener('canplay', onCanPlay);
            this._audio.addEventListener('ended', onEnded);
            this._audio.addEventListener('error', onError);
            if (signal) {
                if (signal.aborted) { onAborted(); return; }
                signal.addEventListener('abort', onAborted, { once: true });
            }
            
            this._audio.src = url;
            this._audio.load();

            playWatchdog = setTimeout(() => finish('watchdog'), 5000);
        });
    } finally {
        release();
    }
  }

  public async playFromBase64(base64: string, cacheKey: string, intentId: number, bakedRate?: number): Promise<void> {
      const buffer = this._base64ToBuffer(base64);
      const blob = new Blob([buffer.buffer as ArrayBuffer], { type: 'audio/mpeg' });
      await this.playBlob(blob, cacheKey, intentId, bakedRate);
  }

  public async playFromCache(cacheKey: string, intentId?: number, bakedRate?: number): Promise<boolean> {
      const blob = await CacheManager.getInstance().get(cacheKey);
      if (blob) {
          await this.playBlob(blob, cacheKey, intentId, bakedRate);
          return true;
      }
      return false;
  }

  private _base64ToBuffer(base64: string): Uint8Array {
      const binaryString = atob(base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes;
  }

  public async ingestData(cacheKey: string, base64: string, intentId: number): Promise<void> {
    if (intentId < this.activeIntentId && this.activeIntentId !== 0) {
        console.warn(`[AUDIO] 🧟 Rejecting stale ingestion: ${intentId} < ${this.activeIntentId}`);
        return;
    }
    try {
        const buffer = this._base64ToBuffer(base64);
        const blob = new Blob([buffer.buffer as ArrayBuffer], { type: 'audio/mpeg' });
        await CacheManager.getInstance().set(cacheKey, blob);
    } catch (e) {
        console.error(`[AUDIO] ❌ Ingestion failed for ${cacheKey}:`, e);
    }
  }

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
            this._utterance.rate = state.rate;
            this._utterance.volume = state.volume / 100;
            console.log(`[RATE_TRACE] 🗣️ speakLocal utterance baked | rate=${state.rate} | vol=${state.volume} | voice=${voiceId ?? 'default'}`);
            console.log(`[VOL_TRACE] 🗣️ speakLocal utterance baked | vol=${state.volume} → utterance.volume=${this._utterance.volume.toFixed(2)}`);

            const onEnd = () => {
                if (this._utterance) {
                    this._utterance.onstart = null;
                    this._utterance.onend = null;
                    this._utterance.onerror = null;
                }
                resolve();
            };

            this._utterance.onstart = () => this.emit(AudioEngineEventType.PLAYING);
            this._utterance.onend = onEnd;
            this._utterance.onerror = () => onEnd();

            this._speechSynth.speak(this._utterance);
        });
    } finally {
        release();
    }
  }

  public async wipeCache(): Promise<void> {
    this.stop();
    await CacheManager.getInstance().clearAll();
  }

  /**
   * scanVoices(): Discovers available browser SpeechSynthesis voices
   * and patches them into the WebviewStore.
   */
  public scanVoices(): void {
    if (typeof window === 'undefined' || !window.speechSynthesis) { return; }
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) { return; }
    const mapped = voices.map(v => ({ name: v.name, voiceURI: v.voiceURI, lang: v.lang, localService: v.localService }));
    WebviewStore.getInstance().patchState({
      availableVoices: {
        local: mapped,
        neural: WebviewStore.getInstance().getState().availableVoices?.neural ?? []
      }
    });
    console.log(`[AUDIO] 🎙️ scanVoices: ${mapped.length} local voices loaded.`);
  }

  /**
   * pause(): Suspends physical audio playback without aborting the intent.
   */
  public pause(): void {
    this._audio.pause();
    this._speechSynth.pause();
  }

  /**
   * resume(): Resumes suspended audio playback.
   */
  public resume(): void {
    if (this._audio.src) {
      this._audio.play().catch(() => {});
    }
    this._speechSynth.resume();
  }

  /**
   * purgeMemory(): Aborts active playback and revokes all object URLs
   * without resetting the intent chain. Used by FIFO queue flushes.
   */
  public purgeMemory(): void {
    this._abortController?.abort();
    this._abortController = null;
    this._audio.pause();
    if (typeof this._audio.removeAttribute === 'function') {
      this._audio.removeAttribute('src');
    } else {
      (this._audio as any).src = '';
    }
    this._activeObjectURLs.forEach(url => URL.revokeObjectURL(url));
    this._activeObjectURLs.clear();
    console.log('[AUDIO] 🧹 purgeMemory: Object URLs revoked.');
  }

  public stop(): void {
    this._abortController?.abort();
    this._abortController = null;
    
    this._audio.pause();
    if (typeof this._audio.removeAttribute === 'function') {
      this._audio.removeAttribute('src');
    } else {
      (this._audio as any).src = '';
    }
    this._audio.load();
    
    this._activeObjectURLs.forEach(url => URL.revokeObjectURL(url));
    this._activeObjectURLs.clear();

    this.stopLocal();
    
    this.pendingResolvers.forEach(resolve => resolve());
    this.pendingResolvers.clear();

    this.playbackMutex = Promise.resolve();
    this._lockOwnerIntentId = null;
    this.activeSequence = 0;
  }

  private stopLocal(): void {
    this._speechSynth.cancel();
    if (this._utterance) {
      this._utterance.onstart = null;
      this._utterance.onend = null;
      this._utterance.onerror = null;
      this._utterance = null;
    }
  }

  public setVolume(val: number): void {
    // [SEAMLESS] Directly update the underlying audio element volume.
    // This does NOT trigger an engine reset or playback interruption.
    this._audio.volume = Math.max(0, Math.min(1, val / 100));
    if (this._utterance) {this._utterance.volume = val / 100;}
  }

  /**
   * _applyPlaybackRate(): Calculates and applies the relative playback rate.
   * Total Rate = (Requested UI Rate) / (Original Synthesis Rate)
   */
  private _applyPlaybackRate(requestedRate?: number): void {
    const state = WebviewStore.getInstance().getState();
    const rate = requestedRate ?? state.rate;
    const engineMode = state.engineMode;
    
    // [LOCAL SYNTH] Browsers handle absolute rate for speechSynthesis natively.
    if (engineMode !== 'neural') {
        this._audio.playbackRate = rate;
        return;
    }

    // [NEURAL RELATIVE] Neural audio is baked with a specific rate (standardized to 1.0 in v2.3.2).
    // We adjust playbackRate relative to that baked reference to reach the UI target.
    const effectiveRate = rate / this.bakedRate;
    
    // [SAUCY RANGES] Most browsers clamp playbackRate between 0.06 and 16.0.
    const clampedRate = Math.max(0.06, Math.min(16.0, effectiveRate));
    
    if (this._audio.playbackRate !== clampedRate) {
        console.log(`[NEURAL_RATE] 🎯 Scale Calculation: UI=${rate.toFixed(2)}x / Baked=${this.bakedRate.toFixed(2)}x → Effective=${clampedRate.toFixed(2)}x`);
        this._audio.playbackRate = clampedRate;
    } else {
        console.log(`[NEURAL_RATE] ⚖️ No change needed: Effective=${clampedRate.toFixed(2)}x (UI=${rate.toFixed(2)}x)`);
    }
  }

  public setRate(val: number): void {
    // [SEAMLESS] Update the rate using relative calculation, passing the explicit target rate.
    this._applyPlaybackRate(val);

    if (this._utterance) {
      console.log(`[RATE_TRACE] 🗣️ Live Utterance Rate Patch | ${this._utterance.rate}→${val}`);
      this._utterance.rate = val;
    }
  }

  public dispose(): void {
    this.stop();
    if (typeof this._audio.remove === 'function') {
      this._audio.remove();
    }
  }
}
