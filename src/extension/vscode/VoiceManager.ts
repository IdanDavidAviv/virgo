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
    public async scanAndSync(): Promise<void> {
        try {
            const { local, neural } = await this._playbackEngine.getVoices();
            this._localVoices = local;
            this._neuralVoices = neural;
            
            this._stateStore.setVoices(local, neural);
            this._logger(`[VOICE_SCAN] SUCCESS: Found ${local.length} local and ${neural.length} neural voices.`);
            
            this.broadcastVoices();
        } catch (e) {
            this._logger(`[VOICE_SCAN] CRITICAL FAILURE: ${e}`);
        }
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

