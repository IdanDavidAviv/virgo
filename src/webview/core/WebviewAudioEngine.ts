import { WebviewStore } from './WebviewStore';
import { PlaybackController } from '../playbackController';
import { AudioStrategy, AudioVoice, OutgoingAction, IncomingCommand, AudioEngineEvent, AudioEngineEventType } from '../../common/types';
import { LocalAudioStrategy } from '../strategies/LocalAudioStrategy';
import { NeuralAudioStrategy } from '../strategies/NeuralAudioStrategy';
// [SOVEREIGNTY] MessageClient dependency removed from Engine layer.

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
  public onEvent?: (event: AudioEngineEvent) => void;
  private _isPrimed: boolean = false;
  private playbackLock: Promise<void> = Promise.resolve();

  private constructor() {
    this.localStrategy = new LocalAudioStrategy();
    this.neuralStrategy = new NeuralAudioStrategy();
    this.activeStrategy = this.localStrategy; 
    
    // [PASSIVE BINDING] Bubble strategy events up to the sovereign layer
    this.localStrategy.onEvent = (e) => this.onEvent?.(e);
    this.neuralStrategy.onEvent = (e) => this.onEvent?.(e);

    this.setupListeners();
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
      this.instance.dispose();
    }
    if (typeof window !== 'undefined' && (window as any).__AUDIO_ENGINE__) {
        (window as any).__AUDIO_ENGINE__.dispose();
        (window as any).__AUDIO_ENGINE__ = undefined;
    }
    this.instance = undefined as any;
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

    // 3. [INTENT SYNC] Removed legacy intent property.
    // Use PlaybackController state if internal logic gating is needed.

    // [SOVEREIGNTY] SYNTHESIS_READY logic moved to PlaybackController.

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

  public async play(intentId?: number): Promise<void> {
    const unlock = await this.acquirePlaybackLock();
    try {
        await this.activeStrategy.play(intentId);
    } finally {
        unlock();
    }
  }

  public async acquirePlaybackLock(): Promise<() => void> {
    let resolveUnlock: () => void;
    const newLock = new Promise<void>(resolve => {
        resolveUnlock = resolve;
    });

    const previousLock = this.playbackLock;
    // [HARDENED] Ensure the next lock is chained even if the previous one catches/rejects.
    this.playbackLock = previousLock.then(() => newLock, () => newLock);

    // [HARDENED] If the previous lock rejected, we still want to acquire the current one.
    return previousLock.then(
        () => resolveUnlock,
        () => resolveUnlock
    );
  }

  public isStrategyActive(strategyId: string): boolean {
    return this.activeStrategy.id === strategyId;
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

  public prepareForPlayback(): void {
    // [SOVEREIGNTY] Reset logic moved to PlaybackController.
  }

  public async playBlob(blob: Blob, cacheKey: string, intentId?: number): Promise<void> {
    const { playbackIntent } = WebviewStore.getInstance().getUIState();
    if (playbackIntent === 'STOPPED') {
        console.log('[AudioEngine] 🛑 Sovereignty Guard: Rejecting playBlob because intent is STOPPED');
        return;
    }

    const unlock = await this.acquirePlaybackLock();
    try {
        await this.neuralStrategy.playBlob(blob, cacheKey, intentId);
    } finally {
        unlock();
    }
  }

  public startAdaptiveWait(cacheKey: string, intentId: number): Promise<void> {
    return this.neuralStrategy.startAdaptiveWait(cacheKey, intentId);
  }

  public setTarget(cacheKey: string | null): void {
      this.neuralStrategy.setTarget(cacheKey);
  }

  public async ingestData(cacheKey: string, base64Data: string, intentId: number): Promise<void> {
      const unlock = await this.acquirePlaybackLock();
      try {
          await this.neuralStrategy.ingestData(cacheKey, base64Data, intentId);
      } finally {
          unlock();
      }
  }

  public handleSynthesisReady(cacheKey: string, intentId: number): void {
      this.neuralStrategy.handleSynthesisReady(cacheKey, intentId);
  }

  public async playFromBase64(base64: string, cacheKey?: string, intentId?: number): Promise<void> {
      await this.neuralStrategy.playFromBase64(base64, cacheKey, intentId);
  }

  public async playFromCache(cacheKey: string, intentId?: number): Promise<boolean> {
      const unlock = await this.acquirePlaybackLock();
      try {
          if (this.activeStrategy.playFromCache) {
              return await this.activeStrategy.playFromCache(cacheKey, intentId);
          }
          return false;
      } finally {
          unlock();
      }
  }

  public async synthesize(text: string, voice?: AudioVoice, intentId?: number): Promise<void> {
    const unlock = await this.acquirePlaybackLock();
    try {
        await this.activeStrategy.synthesize(text, voice, intentId);
    } finally {
        unlock();
    }
  }

  public pause(): void {
    this.localStrategy.pause();
    this.neuralStrategy.pause();
  }

  public resume(): void {
    this.activeStrategy.resume();
  }

  public stop(): void {
    this.localStrategy.stop();
    this.neuralStrategy.stop();
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
    // [TEST COMPAT] Strategies now expose their players for legacy test spying.
    return (this.neuralStrategy as any).audio;
  }

  /**
   * [SOVEREIGNTY] resetLoadingStates moved to Controllers.
   */
  public resetLoadingStates(): void {}
}
