import { AudioStrategy, AudioVoice, AudioEngineEventType, AudioEngineEvent } from '../../common/types';
import { CacheManager } from '../cacheManager';
import { WebviewStore } from '../core/WebviewStore';

/**
 * NeuralAudioStrategy: High-Fidelity Blob/Cache Implementation.
 * Orchestrates JIT synthesis, Direct-Push ingestion, and memory-safe Blob playback.
 * [PASSIVE WORKER]: Reports lifecycle events to the Engine/Controller.
 */
export class NeuralAudioStrategy implements AudioStrategy {
    public id: string = 'neural';
    public audio: HTMLAudioElement;
    private cache: CacheManager;
    public onEvent?: (event: AudioEngineEvent) => void;
    
    private activeIntentId: number = 0;
    private sovereignUrl: string | null = null;
    private activeObjectURLs: Set<string> = new Set();
    private waitResolvers: Map<string, () => void> = new Map();
    private waitTimers: Map<string, any> = new Map();
    private pendingCacheKey: string | null = null;
    private targetCacheKey: string | null = null;

    constructor() {
        this.audio = new Audio();
        this.audio.id = 'neural-player';
        this.audio.preload = 'auto';
        this.cache = new CacheManager();
        this.setupAudioListeners();
    }

    public getName(): string {
        return 'Neural (Cloud)';
    }

    private setupAudioListeners(): void {
        this.audio.onplay = () => {
            if (this.audio.src !== this.sovereignUrl) {return;}
            this.onEvent?.({ type: AudioEngineEventType.PLAYING, intentId: this.activeIntentId });
        };

        this.audio.onpause = () => {
            if (this.audio.src !== this.sovereignUrl) {return;}
            this.onEvent?.({ type: AudioEngineEventType.PAUSED, intentId: this.activeIntentId });
        };

        this.audio.onended = () => {
            if (this.audio.src !== this.sovereignUrl) {return;}
            console.log('[NeuralStrategy] ✅ onended fired');
            this.onEvent?.({ type: AudioEngineEventType.ENDED, intentId: this.activeIntentId });
        };

        this.audio.onerror = (e) => {
            if (this.audio.src !== this.sovereignUrl) {return;}
            const msg = `Audio error: ${(e as any).message || 'Unknown error'}`;
            this.onEvent?.({ type: AudioEngineEventType.ERROR, intentId: this.activeIntentId, message: msg });
        };

        this.audio.onwaiting = () => {
            if (this.audio.src === this.sovereignUrl) {
                this.onEvent?.({ type: AudioEngineEventType.STALLED, intentId: this.activeIntentId });
            }
        };

        this.audio.onplaying = () => {
            if (this.audio.src !== this.sovereignUrl) {return;}
            this.onEvent?.({ type: AudioEngineEventType.PLAYING, intentId: this.activeIntentId });
        };

        this.audio.onstalled = () => {
            if (this.audio.src !== this.sovereignUrl) {return;}
            console.warn(`[NeuralStrategy] ⚠️ onstalled fired (Network/Buffer Issue)`);
        };

        this.audio.onsuspend = () => {
            if (this.audio.src !== this.sovereignUrl) {return;}
            console.log(`[NeuralStrategy] 💤 onsuspend fired (Element suspended)`);
        };
    }

    public async synthesize(_text: string, _voice?: AudioVoice, intentId?: number): Promise<void> {
        if (intentId !== undefined) {
            this.activeIntentId = intentId;
        }
        // [PASSIVE] Synthesis requests are now driven by the Controller.
    }

    public async play(intentId?: number): Promise<void> {
        if (intentId !== undefined && intentId < this.activeIntentId) {
            console.log(`[NeuralStrategy] 🧟 Zombie Guard: Rejecting play() for stale intent ${intentId}`);
            return;
        }
        if (this.audio.src && this.audio.paused) {
            await this.audio.play();
        }
    }

    public pause(): void {
        this.audio.pause();
    }

    public resume(): void {
        if (this.audio.src && this.audio.paused) {
            this.audio.play().catch(e => console.warn('[NeuralStrategy] Resume failed', e));
        }
    }

    public stop(): void {
        this.audio.pause();
        this.audio.currentTime = 0;
        const oldUrl = this.audio.src;
        this.audio.src = '';
        if (oldUrl && typeof oldUrl === 'string' && oldUrl.startsWith('blob:') && this.activeObjectURLs.has(oldUrl)) {
            URL.revokeObjectURL(oldUrl);
            this.activeObjectURLs.delete(oldUrl);
        }
        this.sovereignUrl = null;
        this.clearAdaptiveWait();
    }

    public setVolume(value: number): void {
        this.audio.volume = Math.max(0, Math.min(1, value / 100));
    }

    public setRate(value: number): void {
        // Standardized formula: -10 to 10 maps to 0.5x to 2x (linear approximation)
        // Normal (0) = 1.0x
        this.audio.playbackRate = value >= 0 ? 1 + (value / 10) : 1 + (value / 20);
        console.log(`[NeuralStrategy] 🎚️ Rate set to: ${this.audio.playbackRate} (mapped from ${value})`);
    }

    public setTarget(cacheKey: string | null): void {
        this.targetCacheKey = cacheKey;
    }

    public async startAdaptiveWait(cacheKey: string, intentId: number): Promise<void> {
        if (intentId < this.activeIntentId) {return;}
        this.activeIntentId = intentId;
        this.pendingCacheKey = cacheKey;

        this.clearSpecificWait(cacheKey);
        
        return new Promise((resolve) => {
            this.waitResolvers.set(cacheKey, resolve);
            const timer = setTimeout(() => {
                if (this.audio.paused && cacheKey === this.targetCacheKey) {
                    this.onEvent?.({ type: AudioEngineEventType.STALLED, intentId: this.activeIntentId });
                }
                this.resolveSpecificWait(cacheKey);
            }, 40);
            this.waitTimers.set(cacheKey, timer);
        });
    }

    public handleSynthesisReady(cacheKey: string, intentId: number): void {
        console.log(`[NeuralStrategy] 🔔 handleSynthesisReady received: ${cacheKey} | Intent: ${intentId}`);
        // [PASSIVE] Fetch orchestration moved to PlaybackController.
    }

    public async ingestData(cacheKey: string, base64: string, intentId: number): Promise<void> {
        console.log('[NeuralStrategy] 📥 ingestData (Passive Worker)', { cacheKey, intentId });
        
        // [INTENT LATCH]
        if (intentId < this.activeIntentId) {
            console.log('[NeuralStrategy] ⚠️ ingestData rejected: stale intentId');
            return;
        }

        const blob = this.base64ToBlob(base64);
        this.cache.set(cacheKey, blob).catch(err => console.error('[NeuralStrategy] Cache save failed:', err));

        // [RESOLUTION]
        if (this.pendingCacheKey === cacheKey || this.targetCacheKey === cacheKey) {
            this.clearAdaptiveWait();
        }

        if (intentId === this.activeIntentId) {
            await this.playBlob(blob, cacheKey, intentId);
        }
    }

    public async playFromBase64(base64: string, cacheKey?: string, intentId?: number): Promise<void> {
        if (intentId !== undefined && intentId < this.activeIntentId) {
            console.log(`[NeuralStrategy] 🧟 Zombie Guard: Rejecting playFromBase64 for stale intent ${intentId} (current: ${this.activeIntentId})`);
            return;
        }
        if (intentId !== undefined) {this.activeIntentId = intentId;}
        
        const blob = this.base64ToBlob(base64);
        if (cacheKey) {
            this.cache.set(cacheKey, blob).catch(err => console.error('[NeuralStrategy] Cache save failed:', err));
        }
        await this.playBlob(blob, cacheKey || `base64-${Date.now()}`, intentId);
    }

    public async playFromCache(cacheKey: string, intentId?: number): Promise<boolean> {
        const blob = await this.cache.get(cacheKey);
        if (blob) {
            // [INTENT GUARD]
            if (intentId !== undefined && intentId < this.activeIntentId) {
                console.log(`[NeuralStrategy] 🧟 Zombie Guard: Pruning late cache play for intent ${intentId} (current: ${this.activeIntentId})`);
                return false;
            }
            if (intentId !== undefined) {this.activeIntentId = intentId;}
            
            this.clearAdaptiveWait();
            await this.playBlob(blob, cacheKey, intentId);
            return true;
        }
        return false;
    }

    public async wipeCache(): Promise<void> {
        this.dispose();
        await this.cache.clearAll();
    }

    public async playBlob(blob: Blob, cacheKey: string, intentId?: number): Promise<void> {
        // [SOVEREIGNTY GUARD] Check global intent before any playback
        const { playbackIntent } = WebviewStore.getInstance().getUIState();
        if (playbackIntent === 'STOPPED') {
            console.log(`[NeuralStrategy] 🛑 Sovereignty Guard: Rejecting blob for intentId ${intentId} - USER HAS STOPPPED.`);
            return;
        }

        // [SOVEREIGNTY] Strategy must only play if its engine type is ACTIVE in the store
        const { selectedVoice } = WebviewStore.getInstance().getState() || {};
        if (selectedVoice && !selectedVoice.startsWith('Neural:')) {
            console.log(`[NeuralStrategy] 🛑 Strategy inactive (Voice: ${selectedVoice}). Rejecting playBlob.`);
            return;
        }

        if (intentId !== undefined && intentId < this.activeIntentId) {
            console.log(`[NeuralStrategy] 🧟 Zombie Guard: Pruning blob for stale intentId ${intentId} (current: ${this.activeIntentId}).`);
            return;
        }
        if (intentId !== undefined) {this.activeIntentId = intentId;}
        
        // Teardown previous state
        this.audio.pause();
        const oldUrl = this.audio.src;
        this.audio.src = '';
        this.audio.load();

        if (oldUrl && oldUrl.startsWith('blob:') && this.activeObjectURLs.has(oldUrl)) {
            URL.revokeObjectURL(oldUrl);
            this.activeObjectURLs.delete(oldUrl);
        }

        // Ingest new blob
        const url = URL.createObjectURL(blob);
        this.activeObjectURLs.add(url);
        this.sovereignUrl = url;
        
        console.log(`[NeuralStrategy] 🚀 playBlob PREPARE: ${url} | Size: ${blob.size} bytes | Type: ${blob.type} | Intent: ${this.activeIntentId}`);
        
        this.audio.src = url;

        // [WATCHDOG] Start safety timer
        const playbackWatchdog = setTimeout(() => {
            if (this.audio.src === url && this.audio.paused && !this.audio.ended && this.activeIntentId === intentId) {
                console.error(`[NeuralStrategy] 🚨 PLAYBACK HUNG: Watchdog triggered.`);
                this.onEvent?.({ type: AudioEngineEventType.STALLED, intentId: this.activeIntentId });
            }
        }, 2000);

        try {
            await this.audio.play();
            clearTimeout(playbackWatchdog);
            console.log(`[NeuralStrategy] ✅ play() promise resolved for ${url}`);
        } catch (e: any) {
            clearTimeout(playbackWatchdog);
            if (e.name === 'AbortError') {
                console.log('[NeuralStrategy] ⚠️ Play aborted by system (intentional)');
            } else if (e.name === 'NotAllowedError') {
                this.onEvent?.({ type: AudioEngineEventType.ERROR, intentId: this.activeIntentId, message: 'Audio blocked by browser.' });
            } else {
                console.warn('[NeuralStrategy] ⛔ Play failed', {
                    name: e.name,
                    message: e.message,
                    code: e.code,
                    cacheKey
                });
            }
        }
    }

    public async getVoices(): Promise<AudioVoice[]> {
        return []; 
    }

    private base64ToBlob(base64: string): Blob {
        let cleaned = base64.trim();
        const match = cleaned.match(/^data:audio\/[^;]+;base64,(.+)$/i);
        if (match) {cleaned = match[1];}
        
        const byteCharacters = atob(cleaned);
        const byteNumbers = new Uint8Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        return new Blob([byteNumbers], { type: 'audio/mpeg' });
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

    private clearAdaptiveWait(): void {
        for (const key of this.waitTimers.keys()) {
            this.clearSpecificWait(key);
        }
    }

    public dispose(): void {
        this.stop();
        this.activeObjectURLs.forEach(url => URL.revokeObjectURL(url));
        this.activeObjectURLs.clear();
    }
}
