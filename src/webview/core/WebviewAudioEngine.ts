import { WebviewStore } from './WebviewStore';
import { PlaybackController } from '../playbackController';
import { AudioStrategy, AudioVoice, OutgoingAction, IncomingCommand } from '../../common/types';
import { LocalAudioStrategy } from '../strategies/LocalAudioStrategy';
import { NeuralAudioStrategy } from '../strategies/NeuralAudioStrategy';

/**
 * WebviewAudioEngine: High-Integrity Audio Lifecycle Manager
 * Wraps the HTMLAudioElement and manages raw Blob playback and memory cleanup.
 */
export class WebviewAudioEngine {
  private static instance: WebviewAudioEngine;
  public instanceId: number = Math.random();
  private activeStrategy: AudioStrategy;
  private localStrategy: LocalAudioStrategy;
  private neuralStrategy: NeuralAudioStrategy;
  private activeIntentId: number = 0;
  public intent: 'PLAYING' | 'PAUSED' | 'STOPPED' = 'PAUSED';
  private _isPrimed: boolean = false;

  private constructor() {
    this.localStrategy = new LocalAudioStrategy();
    this.neuralStrategy = new NeuralAudioStrategy();
    this.activeStrategy = this.localStrategy; 
    
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
    this.localStrategy.dispose();
    this.neuralStrategy.dispose();
  }


  private setupListeners(): void {
    const store = WebviewStore.getInstance();

    // 1. [REACTIVE] Real-time settings synchronization
    store.subscribe((s) => s.volume, (vol) => {
        if (vol !== undefined) { this.setVolume(vol); }
    });
    store.subscribe((s) => s.rate, (rate) => {
        if (rate !== undefined) { this.setRate(rate); }
    });

    // 2. [STRATEGY SYNC] Switch strategies based on voice selection
    store.subscribe((s) => s.selectedVoice, (voiceId) => {
        this.updateStrategy(voiceId);
    });

    // 3. [INTENT SYNC] Local playback intent (for logic gating)
    store.subscribeUI((ui) => ui.playbackIntent, (intent) => {
        this.intent = intent as any;
    });

    // 4. Initial sync
    const state = store.getState();
    if (state?.selectedVoice) {
        this.updateStrategy(state.selectedVoice);
    }
  }

  private updateStrategy(voice: AudioVoice | string | undefined): void {
      const voiceId = typeof voice === 'object' ? voice.id : voice;
      const isNeural = voiceId?.startsWith('Neural:');
      const newStrategy = isNeural ? this.neuralStrategy : this.localStrategy;
      
      if (this.activeStrategy !== newStrategy) {
          console.log(`[AudioEngine] 🔄 Switching strategy to: ${isNeural ? 'NEURAL' : 'LOCAL'}`);
          this.activeStrategy.stop();
          this.activeStrategy = newStrategy;
      }
  }

  public async play(): Promise<void> {
    await this.activeStrategy.play();
  }

  /**
   * [NEW] Universal Unlocker: Primes the audio subsystem during a user gesture.
   * CALL THIS synchronously in the onClick handler before any async/IPC logic.
   */
  public ensureAudioContext(): void {
    if (this._isPrimed) { return; }

    // [SILENT PRIME] Use a separate, muted, empty audio element to "bless" 
    // the audio context during a user gesture without playing actual sounds.
    const primer = new Audio();
    primer.muted = true;
    const playPromise = primer.play();
    
    // Handle environments where play() might not return a Promise (e.g. JSDOM)
    if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(() => {
            this._isPrimed = true;
            console.log('[AudioEngine] 🔓 Audio subsystem primed silently via User Gesture');
        }).catch(() => {
            // Expected if no interaction occurred yet, we will retry on next interaction
        });
    } else {
        this._isPrimed = true;
    }
  }

  public prepareForPlayback(): number {
    this.activeIntentId++;
    console.log('[AudioEngine] 🚀 prepareForPlayback', { intentId: this.activeIntentId });
    this.resetLoadingStates();
    return this.activeIntentId;
  }

  public async playBlob(blob: Blob, cacheKey: string, intentId?: number): Promise<void> {
    await this.neuralStrategy.playBlob(blob, cacheKey, intentId);
  }

  public startAdaptiveWait(cacheKey: string, intentId: number): Promise<void> {
    this.activeIntentId = intentId;
    return this.neuralStrategy.startAdaptiveWait(cacheKey, intentId);
  }

  public setTarget(cacheKey: string | null): void {
      this.neuralStrategy.setTarget(cacheKey);
  }

  public async ingestData(cacheKey: string, base64Data: string, intentId: number): Promise<void> {
      await this.neuralStrategy.ingestData(cacheKey, base64Data, intentId);
  }

  public async playFromBase64(base64: string, cacheKey?: string, intentId?: number): Promise<void> {
      await this.neuralStrategy.playFromBase64(base64, cacheKey, intentId);
  }

  public async playFromCache(cacheKey: string, intentId?: number): Promise<boolean> {
      if (this.activeStrategy.playFromCache) {
          return await this.activeStrategy.playFromCache(cacheKey, intentId);
      }
      return false;
  }

  public async synthesize(text: string, voice?: AudioVoice, intentId?: number): Promise<void> {
      this.activeIntentId = intentId || this.activeIntentId;
      await this.activeStrategy.synthesize(text, voice, intentId);
  }

  public pause(): void {
    this.activeStrategy.pause();
    this.intent = 'PAUSED';
    this.resetLoadingStates();
  }

  public resume(): void {
    this.activeStrategy.resume();
    this.intent = 'PLAYING';
  }

  public stop(): void {
    this.activeStrategy.stop();
    this.intent = 'STOPPED';
    this.resetLoadingStates();
  }

  // --- TEST COMPATIBILITY LAYER ---
  // (Removed legacy sovereignUrl and base64ToBlob bindings; tests now access neuralStrategy directly)

  public setVolume(value: number): void {
    this.localStrategy.setVolume(value);
    this.neuralStrategy.setVolume(value);
  }

  public setRate(value: number): void {
    this.localStrategy.setRate(value);
    this.neuralStrategy.setRate(value);
  }

  public async wipeCache(): Promise<void> {
    await this.neuralStrategy.wipeCache();
  }

  /**
   * [IPC] Comprehensive memory and cache cleanup.
   */
  public async purgeMemory(): Promise<void> {
      console.log('[AudioEngine] 🧹 Purging memory and cache...');
      await this.wipeCache();
      this.localStrategy.stop(); // Ensure local is also quiet
  }

  /**
   * [TEST COMPAT] Returns the underlying audio element from the neural strategy.
   * Used by legacy tests to spy on playback events.
   */
  public getAudioElement(): HTMLAudioElement {
    return this.neuralStrategy.audio;
  }

  /**
   * [TEST PARITY] Comprehensive reset for all loading and sync indicators.
   */
  public resetLoadingStates(): void {
      const store = WebviewStore.getInstance();
      store.patchState({
          playbackStalled: false
      });
      store.updateUIState({
          isAwaitingSync: false
      });
  }
}
