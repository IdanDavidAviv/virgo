import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { PlaybackEngine } from '@core/playbackEngine';
import { UISyncPacket, IncomingCommand, SnippetHistory, WindowSentence } from '../../common/types';

export class DashboardRelay {
    private _view?: vscode.WebviewView;
    // [Hygiene] Voice scan idempotency — only emit if the voice list has changed since last broadcast.
    private _lastVoiceHash: string = '';
    private _initialHydrationDone: boolean = false;
    private _isReady: boolean = false;
    private _playBuffer: any[] = [];
    // [T-101] Monotonic counter stamped on every UI_SYNC packet.
    // Webview uses this to protect sovereign fields from out-of-order delivery.
    private _syncCounter: number = 0;

    constructor(
        private readonly _stateStore: StateStore,
        private readonly _docController: DocumentLoadController,
        private readonly _playbackEngine: PlaybackEngine,
        private readonly _logger: (msg: string) => void
    ) {}

    public setView(view: vscode.WebviewView | undefined) {
        if (this._view && this._view !== view) {
            this._logger(`[DashboardRelay] 🔄 Replacing existing view. Cleaving old connection.`);
        }
        this._view = view;
        this._initialHydrationDone = false; // Reset hydration flag for new view
        this._syncCounter = 0;             // [T-101] Reset counter on every view attach to prevent stale-ID dead-UI on reload
        if (view) {
            this._logger(`[DashboardRelay] 🔌 New view attached.`);
        }
    }

    public clearView() {
        if (this._view) {
            this._logger(`[DashboardRelay] 🏳️ Connection severed.`);
            this._view = undefined;
            this._isReady = false;
            this._playBuffer = [];
        }
    }

    public setReady() {
        if (!this._isReady) {
            this._logger(`[DashboardRelay] 🏁 Webview signaled READY. Flushing ${this._playBuffer.length} buffered messages.`);
            this._isReady = true;
            const buffer = [...this._playBuffer];
            this._playBuffer = [];
            buffer.forEach(msg => this.postMessage(msg));
        }
    }

    /**
     * [COLD-BOOT GATE] Authorize the relay to forward isPlaying:true to the webview.
     * MUST be called only from explicit user-initiated play/continue code paths.
     * Never call from init, hydration, or synthesis-warmup paths.
     */
    public authorizePlayback(): void {
        if (!this._stateStore.state.playbackAuthorized) {
            this._logger('[DashboardRelay] ✅ Playback authorized by user gesture.');
            this._stateStore.patchState({ playbackAuthorized: true });
        }
    }

    /** [COLD-BOOT GATE] Read-only accessor for the authorization state. Used by SyncManager dedup hash. */
    public get isPlaybackAuthorized(): boolean {
        return !!this._stateStore.state.playbackAuthorized;
    }

    /**
     * The single source of truth for the dashboard's state.
     * Aggregates StateStore, DocController, and logic into one packet.
     */
    public sync() {
        if (!this._view) { return; }

        const s = this._stateStore.state;
        
        // [INTEGRITY] Validation Guard: Check for undefined properties that should be numeric/objects
        const missingFields: string[] = [];
        if (s.currentChapterIndex === undefined) {missingFields.push('currentChapterIndex');}
        if (s.currentSentenceIndex === undefined) {missingFields.push('currentSentenceIndex');}
        if (s.volume === undefined) {missingFields.push('volume');}
        
        if (missingFields.length > 0) {
            this._logger(`[DashboardRelay] ⚠️ WARNING: StateStore has undefined fields: ${missingFields.join(', ')}. Applying emergency fallback.`);
        }

        const chapters = this._docController.chapters || [];
        const currentChapterIndex = s.currentChapterIndex ?? 0;
        const currentSentenceIndex = s.currentSentenceIndex ?? 0;



        const currentChapter = (currentChapterIndex >= 0 && currentChapterIndex < chapters.length) 
            ? chapters[currentChapterIndex] 
            : null;

        const cacheStats = this._playbackEngine.getCacheStats() || { count: 0, sizeBytes: 0 };
        const config = vscode.workspace.getConfiguration('virgo');
        const logLevel = config.get<string>('logging.level', 'Standard') === 'Verbose' ? 2 : 1;

        const packet: UISyncPacket = {
            // FOCUSED (Passive Selection)
            focusedFileName: s.focusedFileName || 'No Selection',
            focusedRelativeDir: s.focusedRelativeDir || '',
            focusedDocumentUri: s.focusedDocumentUri?.toString() || null,
            focusedIsSupported: !!s.focusedIsSupported,
            focusedVersionSalt: s.focusedVersionSalt,

            // ACTIVE (Loaded Reader)
            activeFileName: s.activeFileName || 'No File Loaded',
            activeRelativeDir: s.activeRelativeDir || '',
            activeDocumentUri: s.activeDocumentUri?.toString() || null,
            versionSalt: s.versionSalt,

            // Playback Progress
            currentChapterIndex,
            currentSentenceIndex,
            
            // UI Flags
            isRefreshing: !!s.isRefreshing,
            isPreviewing: !!s.isPreviewing,
            isSelectingVoice: !!s.isSelectingVoice,
            activeMode: s.activeMode || 'FILE',
            isLooping: !!s.isLooping,

            // [SOVEREIGNTY] Active Playback Configuration
            // [COLD-BOOT GATE] Only propagate isPlaying:true after an explicit play/continue action
            // has been authorized via authorizePlayback(). Engine-internal state (synthesis warmup,
            // hydration sequences) must never leak into the webview as a playing signal.
            isPlaying: this._stateStore.state.playbackAuthorized ? !!s.isPlaying : false,
            isPaused: !!s.isPaused,
            playbackStalled: !!s.playbackStalled,
            volume: s.volume ?? 50,
            rate: s.rate ?? 1.0,
            engineMode: s.engineMode || 'local',
            autoPlayMode: s.autoPlayMode || 'auto',
            selectedVoice: s.selectedVoice,

            // Data Windows
            currentSentences: currentChapter ? currentChapter.sentences : [],
            allChapters: chapters.map((c, i) => ({
                title: c.title || `Chapter ${i+1}`,
                level: c.level ?? 0,
                index: i,
                count: c.sentences ? c.sentences.length : 0
            })),
            
            // Integrity & Cache
            cacheCount: cacheStats.count ?? 0,
            cacheSizeBytes: cacheStats.sizeBytes ?? 0,
            isHydrated: !!s.isHydrated,
            playbackAuthorized: !!s.playbackAuthorized,
            playbackIntentId: Math.max(1, s.playbackIntentId ?? 1),
            batchIntentId: Math.max(1, s.batchIntentId ?? 1),
            lastLoadType: s.lastLoadType || 'none',
            activeSessionId: s.activeSessionId,
            logLevel: logLevel,
            mcpStatus: s.mcpStatus,
            mcpActiveAgents: s.mcpActiveAgents,
            snippetHistory: s.snippetHistory,
            windowSentences: this._calculateWindowSentences(currentChapterIndex, currentSentenceIndex),
            syncIntentId: ++this._syncCounter  // [T-101] Monotonic packet sequence — webview uses this to protect sovereign fields
        };

        this._logger(`[RELAY] 📦 Assembled Packet: active=${packet.activeFileName}, focus=${packet.focusedFileName}, chapters=${packet.allChapters.length}, sets=${packet.currentSentences.length}, hydrated=${packet.isHydrated}, intent=${packet.playbackIntentId}`);
        
        this.postMessage({ command: IncomingCommand.UI_SYNC, ...packet });

        // [INIT-GAP] Immediate Hydration Ritual
        // Trigger voices and cache stats immediately after the first sync pulse to populate the UI.
        if (!this._initialHydrationDone) {
            this._logger(`[RELAY] 🚀 Triggering Immediate Initial Hydration (Voices + Cache)`);
            this.broadcastVoices(s.availableVoices.local, s.availableVoices.neural, s.engineMode);
            this.postMessage({ 
                command: IncomingCommand.CACHE_STATS_UPDATE, 
                count: cacheStats.count, 
                sizeBytes: cacheStats.sizeBytes 
            });
            this._initialHydrationDone = true;
        }
    }

    /**
     * Sends a message to the webview.
     * CRITICAL: Whitelist playback commands to pass through even if hidden (to support background play).
     */
    public postMessage(message: any) {
        if (!this._view) { return; }

        const criticalCommands: string[] = [
            IncomingCommand.UI_SYNC, 
            IncomingCommand.PLAY_AUDIO, 
            IncomingCommand.PURGE_MEMORY, 
            IncomingCommand.SYNTHESIS_ERROR, 
            IncomingCommand.STOP, 
            IncomingCommand.PLAYBACK_STATE_CHANGED,
            IncomingCommand.DATA_PUSH,
            IncomingCommand.CLEAR_CACHE_WIPE,
            IncomingCommand.CACHE_STATS_UPDATE,
            IncomingCommand.SPEAK_LOCAL,
            IncomingCommand.VOICES,
            IncomingCommand.ENGINE_STATUS,
            IncomingCommand.SYNTHESIS_READY,
            IncomingCommand.SYNTHESIS_STARTING
        ];
        const isCritical = criticalCommands.includes(message.command);

        if (this._view.visible || isCritical) {
            // [SOVEREIGNTY] Buffer PLAY_AUDIO and DATA_PUSH if the webview isn't READY yet.
            // This prevents "1-press" failures where synthesis completes before the UI is primed.
            const needsBuffer = (
                message.command === IncomingCommand.PLAY_AUDIO || 
                message.command === IncomingCommand.DATA_PUSH ||
                message.command === IncomingCommand.SYNTHESIS_READY ||
                message.command === IncomingCommand.SYNTHESIS_STARTING
            );
            if (needsBuffer && !this._isReady) {
                // [FIFO-HARDENING] Deduplicate buffer: Remove older versions of this command
                // or any command with a lower intentId to ensure the webview starts with the freshest state.
                if (message.intentId !== undefined) {
                    const originalCount = this._playBuffer.length;
                    this._playBuffer = this._playBuffer.filter(m => {
                        const isSameCommand = m.command === message.command;
                        const isStaleIntent = m.intentId !== undefined && m.intentId < message.intentId;
                        return !isSameCommand && !isStaleIntent;
                    });
                    if (this._playBuffer.length < originalCount) {
                        this._logger(`[RELAY] 🗑️ Evicted ${originalCount - this._playBuffer.length} stale commands from buffer for Intent: ${message.intentId}`);
                    }
                }

                this._logger(`[RELAY] ⏳ Buffering command (not READY): ${message.command} | Intent: ${message.intentId || '?'}`);
                this._playBuffer.push(message);
                return;
            }

            this._view.webview.postMessage(message);
            const isPlaybackSignal = [
                IncomingCommand.PLAY_AUDIO, 
                IncomingCommand.DATA_PUSH, 
                IncomingCommand.SYNTHESIS_READY, 
                IncomingCommand.SYNTHESIS_STARTING
            ].includes(message.command);

            if (isPlaybackSignal) {
                this._logger(`[TELEMETRY] 📤 Command Emitted: ${message.command} | Intent: ${message.intentId || '?'}`);
            }
        } else {
            this._logger(`[RELAY] 🚫 postMessage BLOCKED (Hidden & Non-Critical): ${message.command}`);
        }
    }

    public broadcastVoices(local: any[], neural: any[], engineMode: string, force: boolean = false) {
        // [Hygiene] Idempotency guard — skip broadcast if voice list is unchanged.
        const hash = neural.map((v: any) => v.id || v.shortName || v.Name || '').join(',');
        if (!force && hash === this._lastVoiceHash) {
            return;
        }
        this._lastVoiceHash = hash;
        this.postMessage({
            command: IncomingCommand.VOICES,
            voices: local,
            neural: neural,
            engineMode: engineMode,
            playbackIntentId: this._stateStore.state.playbackIntentId
        });
    }

    public broadcastEngineStatus(status: string) {
        this.postMessage({
            command: 'engineStatus',
            status: status,
            playbackIntentId: this._stateStore.state.playbackIntentId
        });
    }

    /**
     * [T-101] Calculates a lean sliding window: HEAD (current) + 4 lookahead sentences.
     * Window is sized to exactly match _processQueue()'s slice(currIdx+1, currIdx+5) prefetch range.
     * Previous BACK=25/FUTURE=75 (100 sentences) was 20x the actual need and caused IPC bloat.
     */
    private _calculateWindowSentences(currC: number, currS: number): WindowSentence[] {
        const chapters = this._docController.chapters;
        if (!chapters || chapters.length === 0) { return []; }

        const window: WindowSentence[] = [];
        const BACK_LIMIT = 0;        // [T-101] No back-history — _processQueue() never reads behind HEAD
        const LOOKAHEAD_LIMIT = 4;   // [T-101] Matches queue.slice(currIdx+1, currIdx+5) exactly

        // 1. Backtrack (BACK_LIMIT=0 — no back-history needed)
        // Block preserved for future re-enablement if the back-window use case changes.
        if (BACK_LIMIT > 0) {
            let bC = currC;
            let bS = currS - 1;
            let bCount = 0;
            while (bCount < BACK_LIMIT && bC >= 0) {
                const currentC = chapters[bC];
                if (!currentC) { bC--; continue; }
                const sentences = currentC.sentences || [];
                if (bS < 0) {
                    bC--;
                    if (bC >= 0 && chapters[bC]) { bS = (chapters[bC].sentences || []).length - 1; }
                    continue;
                }
                if (bS >= 0 && bS < sentences.length) {
                    window.unshift({ text: sentences[bS], cIdx: bC, sIdx: bS });
                }
                bS--;
                bCount++;
            }
        }

        // 2. Add current
        const currentChapter = chapters[currC];
        const currentSentences = currentChapter ? (currentChapter.sentences || []) : [];
        if (currC >= 0 && currC < chapters.length && currS >= 0 && currS < currentSentences.length) {
            window.push({
                text: currentSentences[currS],
                cIdx: currC,
                sIdx: currS
            });
        }

        // 3. Lookahead 4 sentences (total 5 including current HEAD)
        let fC = currC;
        let fS = currS + 1;
        let fCount = 0;

        while (fCount < LOOKAHEAD_LIMIT && fC < chapters.length) {
            const currentC = chapters[fC];
            if (!currentC) {
                fC++;
                fS = 0;
                continue;
            }
            const sentences = currentC.sentences || [];
            if (fS >= sentences.length) {
                fC++;
                fS = 0;
                continue;
            }
            window.push({
                text: sentences[fS],
                cIdx: fC,
                sIdx: fS
            });
            fS++;
            fCount++;
        }

        return window;
    }
}
