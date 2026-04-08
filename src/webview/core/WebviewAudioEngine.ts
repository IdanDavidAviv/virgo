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
  private activeMode: 'local' | 'neural' = 'local';
  private strategies: Map<string, AudioStrategy> = new Map();
  public onEvent?: (event: AudioEngineEvent) => void;
  private _isPrimed: boolean = false;
  private playbackLock: Promise<void> = Promise.resolve();

  private constructor() {
    this.setupListeners();
  }

  private get activeStrategy(): AudioStrategy {
      return this.getStrategy(this.activeMode);
  }

  private getStrategy(mode: 'local' | 'neural'): AudioStrategy {
      let strategy = this.strategies.get(mode);
      if (!strategy) {
          console.log(`[AudioEngine] 🏗️ Lazily creating strategy: ${mode.toUpperCase()}`);
          strategy = mode === 'neural' ? new NeuralAudioStrategy() : new LocalAudioStrategy();
          strategy.onEvent = (e) => this.onEvent?.(e);
          
          // HYDRATION GATE: Ensure new strategy starts with current sovereign settings
          const state = WebviewStore.getInstance().getState();
          const { rate, volume } = this.calculateSettings(state.rate, state.volume);
          strategy.setRate(rate);
          strategy.setVolume(volume);
          
          this.strategies.set(mode, strategy);
      }
      return strategy;
  }

  private calculateSettings(rawRate: number, rawVolume: number) {
      // Sovereign Rate Mapping: -10..10 maps to 0.5x to 2x (linear approximation)
      const mappedRate = rawRate >= 0 ? 1 + (rawRate / 10) : 1 + (rawRate / 20);
      // Sovereign Volume Mapping: 0..100 maps to 0..1.0
      const mappedVol = Math.max(0, Math.min(1, rawVolume / 100));
      return { rate: mappedRate, volume: mappedVol };
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
    this.strategies.forEach(s => s.dispose());
    this.strategies.clear();
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

    // 4. [PLAYBACK SYNC] Reactive halt/pause
    store.subscribe((s) => s.isPaused, (isPaused) => {
        if (isPaused) { this.pause(); }
    });
    store.subscribe((s) => s.isPlaying, (isPlaying) => {
        // Only stop if we are not playing. Stop is more aggressive than pause.
        if (!isPlaying) { this.stop(); }
    });

    // 5. Initial sync
    const state = store.getState();
    if (state?.selectedVoice) {
        this.updateStrategy(state.selectedVoice);
    }
  }

  private updateStrategy(voice: AudioVoice | string | undefined): void {
      const voiceId = typeof voice === 'object' ? voice.id : voice;
      const isNeural = !!voiceId?.startsWith('Neural:');
      const newMode = isNeural ? 'neural' : 'local';
      
      if (this.activeMode !== newMode) {
          console.log(`[AudioEngine] 🔄 Switching mode to: ${newMode.toUpperCase()}`);
          this.strategies.get(this.activeMode)?.stop();
          this.activeMode = newMode;
      }
  }

  public fallbackToLocal(): void {
      console.warn('[AudioEngine] ⚠️ Neural failure detected. Falling back to Local audio.');
      this.strategies.get('neural')?.stop();
      this.activeMode = 'local';
      // Trigger a state update in the store to inform UI
      WebviewStore.getInstance().updateState({ engineMode: 'local' });
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
    return this.activeMode === strategyId;
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
        const strategy = this.getStrategy('neural') as NeuralAudioStrategy;
        await strategy.playBlob(blob, cacheKey, intentId);
    } finally {
        unlock();
    }
  }

  public startAdaptiveWait(cacheKey: string, intentId: number): Promise<void> {
    return (this.getStrategy('neural') as NeuralAudioStrategy).startAdaptiveWait(cacheKey, intentId);
  }

  public setTarget(cacheKey: string | null): void {
      (this.getStrategy('neural') as NeuralAudioStrategy).setTarget(cacheKey);
  }

  public async ingestData(cacheKey: string, base64Data: string, intentId: number): Promise<void> {
      const unlock = await this.acquirePlaybackLock();
      try {
          await (this.getStrategy('neural') as NeuralAudioStrategy).ingestData(cacheKey, base64Data, intentId);
      } finally {
          unlock();
      }
  }

  public handleSynthesisReady(cacheKey: string, intentId: number): void {
      (this.getStrategy('neural') as NeuralAudioStrategy).handleSynthesisReady(cacheKey, intentId);
  }

  public async playFromBase64(base64: string, cacheKey?: string, intentId?: number): Promise<void> {
      await (this.getStrategy('neural') as NeuralAudioStrategy).playFromBase64(base64, cacheKey, intentId);
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
    this.strategies.forEach(s => s.pause());
  }

  public resume(): void {
    this.activeStrategy.resume();
  }

  public stop(): void {
    this.strategies.forEach(s => s.stop());
  }

  // --- TEST COMPATIBILITY LAYER ---
  
  /** @internal Used by legacy tests to spy on strategy behavior. */
  public get localStrategy(): AudioStrategy { return this.getStrategy('local'); }
  /** @internal Used by legacy tests to spy on strategy behavior. */
  public get neuralStrategy(): AudioStrategy { return this.getStrategy('neural'); }

  public setVolume(value: number): void {
    const { volume } = this.calculateSettings(0, value);
    this.strategies.get(this.activeMode)?.setVolume(volume);
  }

  public setRate(value: number): void {
    const { rate } = this.calculateSettings(value, 0);
    this.strategies.get(this.activeMode)?.setRate(rate);
  }

  public async wipeCache(): Promise<void> {
    await (this.getStrategy('neural') as NeuralAudioStrategy).wipeCache();
  }

  /**
   * [IPC] Comprehensive memory and cache cleanup.
   */
  public async purgeMemory(): Promise<void> {
      console.log('[AudioEngine] 🧹 Purging memory and cache...');
      await this.wipeCache();
      this.strategies.get('local')?.stop(); // Ensure local is also quiet without lazy-loading
  }

  /**
   * [TEST COMPAT] Returns the underlying audio element from the neural strategy.
   * Used by legacy tests to spy on playback events.
   */
  public getAudioElement(): HTMLAudioElement {
    return (this.getStrategy('neural') as NeuralAudioStrategy).audio;
  }

  /**
   * [SOVEREIGNTY] resetLoadingStates moved to Controllers.
   */
  public resetLoadingStates(): void {}
}
