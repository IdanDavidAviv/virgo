import { PlaybackEngine } from '@core/playbackEngine';
import { StateStore } from '@core/stateStore';
import { DashboardRelay } from '@vscode/dashboardRelay';

/**
 * Service responsible for scanning, caching, and broadcasting available TTS voices.
 * Extracted from SpeechProvider to improve testability and modularity.
 */
export class VoiceManager {
    private _localVoices: any[] = [];
    private _neuralVoices: any[] = [];

    constructor(
        private readonly _playbackEngine: PlaybackEngine,
        private readonly _stateStore: StateStore,
        private readonly _dashboardRelay: DashboardRelay,
        private readonly _logger: (msg: string) => void
    ) {}

    /**
     * Scans for available voices and synchronizes them with the StateStore and Dashboard.
     */
    public async scanAndSync(retryCount = 0): Promise<void> {
        try {
            // [v2.3.1] Simplified discovery: Extension only scans Neural voices.
            // Local voices are injected via updateLocalVoices when reported by the Webview.
            this._neuralVoices = await this._playbackEngine.getVoices() as any[];
            
            // [HARDENING] Exponential Backoff Retry: If no neural voices found (and within limits).
            // This handles cases where the Edge TTS API might return an empty list momentarily.
            if (this._neuralVoices.length === 0 && retryCount < 3) {
                const backoffMs = Math.pow(2, retryCount) * 1000;
                this._logger(`[VOICE_SCAN] WARNING: No neural voices found. Retrying in ${backoffMs}ms... (Attempt ${retryCount + 1}/3)`);
                await new Promise(res => setTimeout(res, backoffMs));
                return this.scanAndSync(retryCount + 1);
            }

            this._stateStore.setVoices(this._localVoices, this._neuralVoices);
            this._logger(`[VOICE_SCAN] SUCCESS: Found ${this._neuralVoices.length} neural voices. Waiting for local report...`);
            
            this.broadcastVoices();
        } catch (e) {
            this._logger(`[VOICE_SCAN] CRITICAL FAILURE: ${e}`);
        }
    }

    /**
     * Updates the local voice list from a webview report.
     */
    public updateLocalVoices(localVoices: any[]): void {
        this._localVoices = localVoices;
        this._stateStore.setVoices(this._localVoices, this._neuralVoices);
        this._logger(`[VOICE_REPORT] SUCCESS: Received ${localVoices.length} local voices from Webview.`);
        this.broadcastVoices();
    }

    /**
     * Broadcasts current voices to the dashboard.
     */
    public broadcastVoices(): void {
        this._dashboardRelay.broadcastVoices(
            this._localVoices, 
            this._neuralVoices, 
            this._stateStore.state.engineMode
        );
    }

    public get localVoices() { return this._localVoices; }
    public get neuralVoices() { return this._neuralVoices; }

    public dispose() {
        this._logger('[VOICE_MANAGER] Disposed.');
    }
}

