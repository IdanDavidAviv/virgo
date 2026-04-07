import { AudioStrategy, AudioVoice, OutgoingAction } from '../../common/types';
import { MessageClient } from '../core/MessageClient';
import { CacheManager } from '../cacheManager';
import { WebviewStore } from '../core/WebviewStore';
import { ToastManager } from '../components/ToastManager';

/**
 * NeuralAudioStrategy: High-Fidelity Blob/Cache Implementation.
 * Orchestrates JIT synthesis, Direct-Push ingestion, and memory-safe Blob playback.
 */
export class NeuralAudioStrategy implements AudioStrategy {
    public readonly id = 'neural';
    public audio: HTMLAudioElement;
    private cache: CacheManager;
    private activeObjectURLs: Set<string> = new Set();
    private activeIntentId: number = 0;
    private pendingCacheKey: string | null = null;
    private targetCacheKey: string | null = null;
    private waitTimers: Map<string, any> = new Map();
    private waitResolvers: Map<string, () => void> = new Map();
    public sovereignUrl: string | null = null;

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
            WebviewStore.getInstance().patchState({ isPlaying: true, isPaused: false, playbackStalled: false });
        };

        this.audio.onpause = () => {
            if (this.audio.src !== this.sovereignUrl) {return;}
            WebviewStore.getInstance().patchState({ isPaused: true, isPlaying: false, playbackStalled: false });
        };

        this.audio.onended = () => {
            if (this.audio.src !== this.sovereignUrl) {return;}
            console.log('[NeuralStrategy] ✅ onended fired');
            MessageClient.getInstance().postAction(OutgoingAction.SENTENCE_ENDED);
        };

        this.audio.onerror = (e) => {
            if (this.audio.src !== this.sovereignUrl) {return;}
            const msg = `[NeuralStrategy] ⛔ Audio element error: ${(e as any).message || 'Unknown error'}`;
            console.error(msg);
            ToastManager.show(msg, 'error');
        };

        this.audio.onwaiting = () => {
            if (this.audio.src === this.sovereignUrl) {
                console.log(`[NeuralStrategy] ⏳ onwaiting fired (Stall detected) | Intent: ${this.activeIntentId} | Source: ${this.audio.src}`);
                WebviewStore.getInstance().patchState({ playbackStalled: true });
            }
        };

        this.audio.onplaying = () => {
            if (this.audio.src !== this.sovereignUrl) {return;}
            console.log(`[NeuralStrategy] 🔊 onplaying fired | Intent: ${this.activeIntentId}`);
            WebviewStore.getInstance().patchState({ playbackStalled: false });
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

    public async synthesize(text: string, voice?: AudioVoice, intentId?: number): Promise<void> {
        if (intentId !== undefined) {
            this.activeIntentId = intentId;
        }
        
        // Strategy level: Neural synthesis is handled by the extension.
        // We just prepare the target key if we can derive it.
        const store = WebviewStore.getInstance();
        const cacheKey = store.getSentenceKey();
        this.targetCacheKey = cacheKey;

        if (cacheKey) {
            const hit = await this.playFromCache(cacheKey, intentId);
            if (hit) {return;}
            MessageClient.getInstance().postAction(OutgoingAction.REQUEST_SYNTHESIS, { cacheKey, intentId });
        }
    }

    public async play(): Promise<void> {
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
        if (!cacheKey) {
            WebviewStore.getInstance().patchState({ playbackStalled: false });
        }
    }

    public startAdaptiveWait(cacheKey: string, intentId: number): Promise<void> {
        if (intentId < this.activeIntentId) {return Promise.resolve();}
        this.activeIntentId = intentId;
        this.pendingCacheKey = cacheKey;

        this.clearSpecificWait(cacheKey);
        
        return new Promise((resolve) => {
            this.waitResolvers.set(cacheKey, resolve);
            const timer = setTimeout(() => {
                if (this.audio.paused && cacheKey === this.targetCacheKey) {
                    WebviewStore.getInstance().patchState({ playbackStalled: true });
                }
                this.resolveSpecificWait(cacheKey);
            }, 40);
            this.waitTimers.set(cacheKey, timer);
        });
    }

    public async ingestData(cacheKey: string, base64: string, intentId: number): Promise<void> {
        console.log('[NeuralStrategy] 📥 ingestData', { cacheKey, intentId, activeIntent: this.activeIntentId });
        if (intentId < this.activeIntentId) {
            console.log('[NeuralStrategy] ⚠️ ingestData rejected: old intentId');
            return;
        }
        const blob = this.base64ToBlob(base64);
        this.cache.set(cacheKey, blob).catch(err => console.error('[NeuralStrategy] Cache save failed:', err));

        // [ADAPTIVE JIT] If we were waiting for this push, resolve the wait
        if (this.pendingCacheKey === cacheKey || this.targetCacheKey === cacheKey) {
            this.clearAdaptiveWait();
            WebviewStore.getInstance().patchState({ playbackStalled: false });
        }

        // [RESILIENCE] Play even if wait timed out, as long as it's the current intent
        if (intentId === this.activeIntentId) {
            await this.playBlob(blob, cacheKey, intentId);
        }
    }

    public async playFromBase64(base64: string, cacheKey?: string, intentId?: number): Promise<void> {
        if (intentId !== undefined && intentId < this.activeIntentId) {return;}
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
            
            this.clearAdaptiveWait();
            await this.playBlob(blob, cacheKey, intentId);
            return true;
        }
        return false;
    }

    public async wipeCache(): Promise<void> {
        this.dispose();
        await this.cache.clearAll();
        WebviewStore.getInstance().resetCacheStats();
    }

    public async playBlob(blob: Blob, cacheKey: string, intentId?: number): Promise<void> {
        // 1. [INTENT GUARD] Atomic intent tracking
        if (intentId !== undefined) {
            if (intentId < this.activeIntentId) {
                return;
            }
            this.activeIntentId = intentId;
        }

        const store = WebviewStore.getInstance();
        const intent = store.getUIState().playbackIntent;
        const isIntentMatched = intentId !== undefined && intentId === this.activeIntentId;
        const lastStallSource = store.getUIState().lastStallSource;

        // [USER-SOVEREIGN GUARD] 
        // 1. If the user explicitly stopped/paused, honor it immediately regardless of intent matching.
        // 2. If it was an automatic/background sync (AUTO), allow audio through if it matches the current atomic intent sequence.
        const isUserHalt = (intent === 'STOPPED' || intent === 'PAUSED') && lastStallSource === 'USER';
        const isAutoHalt = (intent === 'STOPPED' || intent === 'PAUSED') && lastStallSource === 'AUTO';

        // [DIAGNOSTIC] Log zombie guard logic
        if (intent === 'STOPPED' || intent === 'PAUSED') {
            console.log(`[NeuralStrategy] 🧟 Zombie Check: Intent=${intent}, Source=${lastStallSource}, Matched=${isIntentMatched}, IntentID=${intentId}, Active=${this.activeIntentId}`);
        }

        if (isUserHalt || (isAutoHalt && !isIntentMatched)) {
            console.log(`[NeuralStrategy] 🧟 Zombie Guard: Pruning blob due to ${intent} state (Source: ${lastStallSource}, Match: ${isIntentMatched}).`);
            return;
        }
        
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
        
        // 2. [SANITY CHECK]
        if (this.audio.networkState === HTMLMediaElement.NETWORK_IDLE || this.audio.networkState === HTMLMediaElement.NETWORK_LOADING) {
             console.log(`[NeuralStrategy] Network state looks healthy: ${this.audio.networkState}`);
        }

        this.audio.src = url;

        // 3. [WATCHDOG] Start safety timer
        const playbackWatchdog = setTimeout(() => {
            if (this.audio.src === url && this.audio.paused && !this.audio.ended && this.activeIntentId === intentId) {
                console.error(`[NeuralStrategy] 🚨 PLAYBACK HUNG: Playback watchdog triggered after 2000ms. Force-resetting...`);
                WebviewStore.getInstance().patchState({ playbackStalled: true });
                // We don't call stop() here to avoid recursive loops, but we signal the UI.
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
                console.error('[NeuralStrategy] ⛔ BROWSER BLOCKED AUDIO: User interaction required.', e);
                ToastManager.show('Audio blocked by browser. Click anywhere to re-enable.', 'warning');
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

    public base64ToBlob(base64: string): Blob {
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
