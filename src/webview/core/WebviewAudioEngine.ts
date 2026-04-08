import { WebviewStore } from './WebviewStore';
import { AudioStrategy, AudioVoice, AudioEngineEvent, AudioEngineEventType } from '../../common/types';
import { LocalAudioStrategy } from '../strategies/LocalAudioStrategy';
import { NeuralAudioStrategy } from '../strategies/NeuralAudioStrategy';

/**
 * WebviewAudioEngine: High-Integrity Audio Lifecycle Manager (v2.3.0)
 * Wraps the HTMLAudioElement and manages raw Blob playback and memory cleanup.
 * [SOVEREIGNTY]: Passive worker that executes commands from the Controller.
 */
export class WebviewAudioEngine {
  private static instance: WebviewAudioEngine;
  public instanceId: number = Math.random();
  private activeMode: 'local' | 'neural' = 'local';
  private strategies: Map<string, AudioStrategy> = new Map();
  public onEvent?: (event: AudioEngineEvent) => void;
  private _isPrimed: boolean = false;
  
  // Mutex & Sovereignty
  private playbackMutex: Promise<void> = Promise.resolve();
  private pendingResolvers: Set<() => void> = new Set();
  private activeIntentId: number = 0; // Default to 0 to align with initial store state

  private constructor() {
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

  /**
   * [SOVEREIGNTY] Atomic reset of the entire engine state.
   * Useful for test cleanup or fatal error recovery.
   */
  public static resetInstance(): void {
    if (this.instance) {
      this.instance.dispose();
    }
    if (typeof window !== 'undefined' && (window as any).__AUDIO_ENGINE__) {
        try { (window as any).__AUDIO_ENGINE__.dispose(); } catch(e) {}
        (window as any).__AUDIO_ENGINE__ = undefined;
    }
    this.instance = undefined as any;
  }

  public resetSovereignty(): void {
      console.log('[AUDIO] 🛡️ Resetting Sovereignty...');
      this.stop();
      this.activeIntentId = 0;
      this.playbackMutex = Promise.resolve();
      this.strategies.forEach(s => s.wipeCache?.());
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

    // 4. [PLAYBACK SYNC] Reactive halt/pause
    store.subscribe((s) => s.isPaused, (isPaused) => {
        if (isPaused) { this.pause(); }
    });
    store.subscribe((s) => s.isPlaying, (isPlaying) => {
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
          console.log(`[AUDIO] 🔄 Mode -> ${newMode.toUpperCase()}`);
          this.strategies.get(this.activeMode)?.stop();
          this.activeMode = newMode;
      }
  }

  public fallbackToLocal(): void {
      console.warn('[AUDIO] ⚠️ Neural fallback -> LOCAL');
      this.strategies.get('neural')?.stop();
      this.activeMode = 'local';
      WebviewStore.getInstance().updateState({ engineMode: 'local' });
  }

  private get activeStrategy(): AudioStrategy {
      return this.getStrategy(this.activeMode);
  }

  private getStrategy(mode: 'local' | 'neural'): AudioStrategy {
      let strategy = this.strategies.get(mode);
      if (!strategy) {
          console.log(`[AudioEngine] 🏗️ Creating strategy: ${mode.toUpperCase()}`);
          strategy = mode === 'neural' ? new NeuralAudioStrategy() : new LocalAudioStrategy();
          strategy.onEvent = (e) => this.onEvent?.({ 
              ...e, 
              intentId: e.intentId ?? this.activeIntentId 
          });
          
          const state = WebviewStore.getInstance().getState();
          const { rate, volume } = this.calculateSettings(state.rate, state.volume);
          strategy.setRate(rate);
          strategy.setVolume(volume);
          
          this.strategies.set(mode, strategy);
      }
      return strategy;
  }

  private calculateSettings(rawRate: number, rawVolume: number) {
      const mappedRate = rawRate >= 0 ? 1 + (rawRate / 10) : 1 + (rawRate / 20);
      const mappedVol = Math.max(0, Math.min(1, rawVolume / 100));
      return { rate: mappedRate, volume: mappedVol };
  }

  /**
   * [v2.3.1] Linear Mutex with Intent-Busting: Ensures only one audio operation executes at a time,
   * but allows newer User Intents to proactively "bust" stale, waiting locks.
   */
  public async acquireLock(intentId?: number): Promise<(() => void) | null> {
    if (intentId !== undefined && intentId < this.activeIntentId) {
      console.warn(`[AUDIO] 🛡️ Zombie lock rejected: ${intentId} < ${this.activeIntentId}`);
      return null;
    }

    // [SOVEREIGNTY] Proactively bust ALL previous locks if a newer intent arrives
    if (intentId !== undefined && intentId > this.activeIntentId) {
      console.log(`[AUDIO] 💥 Busting previous locks for intent ${this.activeIntentId} -> ${intentId}`);
      this.pendingResolvers.forEach(resolve => resolve());
      this.pendingResolvers.clear();
      this.activeIntentId = intentId;
    }

    const previousMutex = this.playbackMutex;
    let resolveNext: () => void;
    
    this.playbackMutex = new Promise<void>(resolve => {
        resolveNext = resolve;
    });

    this.pendingResolvers.add(resolveNext!);

    // [v2.3.1] Safety Timeout (Ghost Lock Guard)
    // Reduce to 3s in test environment to avoid Vitest 5s timeouts
    const timeoutMs = (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') ? 3000 : 10000;
    const safetyTimeout = setTimeout(() => {
        console.warn(`[AUDIO] 🛡️ Lock safety timeout (Max Hold) triggered for intent ${intentId ?? 'internal'}`);
        this.pendingResolvers.delete(resolveNext!);
        resolveNext();
    }, timeoutMs);

    // Wait for the chain to settle
    await previousMutex;

    // [SOVEREIGNTY] Final check after waiting: did a NEWER intent arrive while we sat in queue?
    if (intentId !== undefined && intentId < this.activeIntentId) {
        console.warn(`[AUDIO] 🛡️ Intent ${intentId} became stale while waiting. Active: ${this.activeIntentId}`);
        this.pendingResolvers.delete(resolveNext!);
        resolveNext!();
        return null;
    }
    
    return () => {
        clearTimeout(safetyTimeout);
        this.pendingResolvers.delete(resolveNext!);
        resolveNext();
    };
  }

  public ensureAudioContext(): void {
    if (this._isPrimed) { return; }
    const primer = new Audio();
    primer.muted = true;
    const playPromise = primer.play();
    if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(() => {
            this._isPrimed = true;
            console.log('[AudioEngine] 🔓 Audio primed');
        }).catch(() => {});
    } else {
        this._isPrimed = true;
    }
  }

  public async play(intentId?: number): Promise<void> {
    if (this.isStopped()) {return;}
    const release = await this.acquireLock(intentId);
    if (!release) {return;}
    try {
        if (this.isStopped()) {return;}
        await this.activeStrategy.play?.(intentId);
    } finally {
        release();
    }
  }

  public async playBlob(blob: Blob, cacheKey: string, intentId?: number): Promise<void> {
    if (this.isStopped()) {return;}
    const release = await this.acquireLock(intentId);
    if (!release) {return;}
    try {
        if (this.isStopped() || this.activeMode !== 'neural') {
            console.warn(`[AUDIO] 🛡️ playBlob rejected: stopped=${this.isStopped()}, mode=${this.activeMode}`);
            return;
        }
        const strategy = this.getStrategy('neural');
        (strategy as any).playBlob?.(blob, cacheKey, intentId);
    } finally {
        release();
    }
  }

  public async ingestData(cacheKey: string, base64Data: string, intentId: number): Promise<void> {
      await this.getStrategy('neural').ingestData?.(cacheKey, base64Data, intentId);
  }

  public async playFromBase64(base64: string, cacheKey?: string, intentId?: number): Promise<void> {
    if (this.isStopped()) {return;}
    const release = await this.acquireLock(intentId);
    if (!release) {return;}
    try {
        if (this.isStopped() || this.activeMode !== 'neural') {return;}
        await this.getStrategy('neural').playFromBase64?.(base64, cacheKey, intentId);
    } finally {
        release();
    }
  }

  public async playFromCache(cacheKey: string, intentId?: number): Promise<boolean> {
      if (this.isStopped()) {return false;}
      const release = await this.acquireLock(intentId);
      if (!release) {return false;}
      try {
          if (this.isStopped()) {return false;}
          if (this.activeStrategy.playFromCache) {
              return await this.activeStrategy.playFromCache(cacheKey, intentId);
          }
          return false;
      } finally {
          release();
      }
  }

  public isSegmentReady(cacheKey: string): boolean {
    return !!this.activeStrategy.isSegmentReady?.(cacheKey);
  }

  public async synthesize(text: string, voice?: AudioVoice, intentId?: number): Promise<void> {
    const release = await this.acquireLock(intentId);
    if (!release) {return;}
    try {
        await this.activeStrategy.synthesize(text, voice, intentId);
    } finally {
        release();
    }
  }

  public pause(): void {
    console.log('[AudioEngine] ⏸️ PAUSE');
    this.strategies.forEach(s => s.pause());
  }

  public resume(): void {
    console.log('[AudioEngine] ▶️ RESUME');
    this.activeStrategy.resume();
  }

  public stop(): void {
    console.log('[AudioEngine] 🛑 STOP');
    // [SOVEREIGNTY] Unblock EVERYONE waiting for the lock
    this.pendingResolvers.forEach(resolve => resolve());
    this.pendingResolvers.clear();
    this.playbackMutex = Promise.resolve();
    this.strategies.forEach(s => s.stop());
  }

  private isStopped(): boolean {
    const { playbackIntent } = WebviewStore.getInstance().getUIState();
    return playbackIntent === 'STOPPED';
  }

  public setVolume(value: number): void {
    const { volume } = this.calculateSettings(0, value);
    this.strategies.get(this.activeMode)?.setVolume(volume);
  }

  public setRate(value: number): void {
    const { rate } = this.calculateSettings(value, 0);
    this.strategies.get(this.activeMode)?.setRate(rate);
  }

  public async wipeCache(): Promise<void> {
    const strategy = this.getStrategy('neural');
    // [SOVEREIGNTY] Explicitly revoke blobs BEFORE clearing the cache registry
    await (strategy as any).revokeAll?.();
    
    if (strategy.cache) {
        await strategy.cache.clearAll();
    } else {
        await strategy.wipeCache?.();
    }
  }

  public async purgeMemory(): Promise<void> {
      console.log('[AudioEngine] 🧹 Purging...');
      await this.wipeCache();
      this.strategies.get('local')?.stop();
  }

  public getAudioElement(): HTMLAudioElement {
    return (this.getStrategy('neural') as NeuralAudioStrategy).audio;
  }

  // --- Legacy Proxies ---
  public get localStrategy(): AudioStrategy { return this.getStrategy('local'); }
  public get neuralStrategy(): AudioStrategy { return this.getStrategy('neural'); }
}
