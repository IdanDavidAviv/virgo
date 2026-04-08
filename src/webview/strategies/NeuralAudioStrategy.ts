import { AudioStrategy, AudioVoice, AudioEngineEvent, AudioEngineEventType } from '../../common/types';

/**
 * NeuralAudioStrategy (v2.3.0)
 * Optimized for high-throughput Blob/Base64 streaming patterns used by the Neural bridge.
 * [PASSIVE]: Reports all audio events back to the Sovereign Engine.
 */
export class NeuralAudioStrategy implements AudioStrategy {
    public id: string = 'neural';
    public audio: HTMLAudioElement;
    public onEvent?: (event: AudioEngineEvent) => void;
    private currentBlobUrl?: string;
    private segments: Map<string, string> = new Map(); // cacheKey -> URL
    public activeObjectURLs: Set<string> = new Set(); // [TEST] Compatibility for Ghost Audio Guard

    public cache = {
        get: (key: string) => this.segments.get(key),
        has: (key: string) => this.segments.has(key),
        clearAll: () => this.wipeCache(),
        delete: (key: string) => {
            const url = this.segments.get(key);
            if (url) {
                URL.revokeObjectURL(url);
                this.activeObjectURLs.delete(url);
            }
            return this.segments.delete(key);
        }
    };

    constructor() {
        this.audio = new Audio();
        this.setupListeners();
    }

    public getName(): string {
        return 'Neural (Cloud-Enhanced)';
    }

    public async getVoices(): Promise<AudioVoice[]> {
        // [PASSIVE] The extension tells us which voice to use.
        // We return an empty list or the specialized neural voices if needed.
        return [];
    }

    private setupListeners(): void {
        this.audio.onplay = () => this.onEvent?.({ type: AudioEngineEventType.PLAYING });
        this.audio.onpause = () => this.onEvent?.({ type: AudioEngineEventType.PAUSED });
        this.audio.onended = () => this.onEvent?.({ type: AudioEngineEventType.ENDED });
        this.audio.onwaiting = () => this.onEvent?.({ type: AudioEngineEventType.STALLED });
        this.audio.onplaying = () => this.onEvent?.({ type: AudioEngineEventType.PLAYING });
        this.audio.onerror = (e) => {
            console.error('[NeuralStrategy] Audio Error:', e);
            this.onEvent?.({ type: AudioEngineEventType.ERROR, message: 'HTMLAudioElement Error' });
        };
    }

    public setVolume(value: number): void {
        this.audio.volume = value;
    }

    public setRate(value: number): void {
        this.audio.playbackRate = value;
    }

    public async synthesize(text: string, voice?: AudioVoice, intentId?: number): Promise<void> {
        // [PASSIVE] We don't synthesize here. We wait for playBlob or playFromBase64.
        console.log(`[NeuralStrategy] Synthesize ID ${intentId} for: ${text.substring(0, 20)}...`);
    }

    public async play(intentId?: number): Promise<void> {
        if (!this.audio.src) {return;}
        try {
            await this.audio.play();
        } catch (e) {
            console.warn('[NeuralStrategy] Play interrupted:', e);
        }
    }

    public async playBlob(blob: Blob, cacheKey: string, intentId?: number): Promise<void> {
        this.revokeCurrent();
        this.currentBlobUrl = URL.createObjectURL(blob);
        this.segments.set(cacheKey, this.currentBlobUrl);
        this.activeObjectURLs.add(this.currentBlobUrl);
        
        this.audio.src = this.currentBlobUrl;
        await this.play(intentId);
    }

    public async ingestData(cacheKey: string, base64Data: string, intentId: number): Promise<void> {
        if (this.segments.has(cacheKey)) {return;}
        const blob = this.base64ToBlob(base64Data);
        const url = URL.createObjectURL(blob);
        this.segments.set(cacheKey, url);
        this.activeObjectURLs.add(url);
    }

    public async playFromBase64(base64: string, cacheKey?: string, intentId?: number): Promise<void> {
        this.revokeCurrent();
        const blob = this.base64ToBlob(base64);
        this.currentBlobUrl = URL.createObjectURL(blob);
        this.activeObjectURLs.add(this.currentBlobUrl);
        
        if (cacheKey) {
            this.segments.set(cacheKey, this.currentBlobUrl);
        }
        
        this.audio.src = this.currentBlobUrl;
        await this.play(intentId);
    }

    public async playFromCache(cacheKey: string, intentId?: number): Promise<boolean> {
        const url = this.segments.get(cacheKey);
        if (url) {
            this.audio.src = url;
            await this.play(intentId);
            return true;
        }
        return false;
    }

    public isSegmentReady(cacheKey: string): boolean {
        return this.segments.has(cacheKey);
    }

    public pause(): void {
        this.audio.pause();
    }

    public resume(): void {
        this.audio.play().catch(() => {});
    }

    public stop(): void {
        this.audio.pause();
        this.audio.currentTime = 0;
    }

    public async wipeCache(): Promise<void> {
        await this.revokeAll();
        this.segments.clear();
    }

    public async revokeAll(): Promise<void> {
        this.segments.forEach(url => URL.revokeObjectURL(url));
        this.activeObjectURLs.forEach(url => URL.revokeObjectURL(url));
        this.activeObjectURLs.clear();
        this.revokeCurrent();
    }

    private revokeCurrent(): void {
        if (this.currentBlobUrl) {
            URL.revokeObjectURL(this.currentBlobUrl);
            this.currentBlobUrl = undefined;
        }
    }

    public dispose(): void {
        this.stop();
        this.wipeCache();
    }

    private base64ToBlob(base64: string): Blob {
        const binStr = atob(base64);
        const len = binStr.length;
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            arr[i] = binStr.charCodeAt(i);
        }
        return new Blob([arr], { type: 'audio/mpeg' });
    }
}
