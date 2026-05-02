import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateStore } from '@core/stateStore';

/**
 * Service responsible for managing VS Code configuration, legacy settings migration,
 * and persistent document progress.
 */
export class SettingsManager {
    private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private _saveProgressTimer?: NodeJS.Timeout;

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _stateStore: StateStore,
        private readonly _logger: (msg: string) => void,
        private _antigravityRoot: string,
        private _sessionId: string
    ) {}

    /**
     * Initializes settings: migrates legacy state, loads current config, and sets up listeners.
     */
    public initialize(): void {
        this._migrateLegacySettings();
        this._loadConfiguration();
        
        this._context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('virgo')) {
                this._loadConfiguration(e);
            }
        }));
    }

    /**
     * Updates internal session context when the active agent session changes.
     */
    public pivotSession(antigravityRoot: string, sessionId: string): void {
        this._antigravityRoot = antigravityRoot;
        this._sessionId = sessionId;
        this.bridgeAgentState(this._stateStore.state.autoInjectSITREP);
    }

    private _loadConfiguration(event?: vscode.ConfigurationChangeEvent): void {
        const config = vscode.workspace.getConfiguration('virgo');
        const updatedOptions: any = {};

        if (!event || event.affectsConfiguration('virgo.playback')) {
            updatedOptions.rate = config.get<number>('playback.rate', 1.0);
            updatedOptions.volume = config.get<number>('playback.volume', 50);
            updatedOptions.selectedVoice = config.get<string>('playback.voice', 'en-US-SteffanNeural');
            updatedOptions.engineMode = config.get<'local' | 'neural'>('playback.engineMode', 'neural');
            updatedOptions.autoPlayMode = config.get<'auto' | 'chapter' | 'row'>('playback.autoPlayMode', 'auto');
            updatedOptions.autoPlayOnInjection = config.get<boolean>('playback.autoPlayOnInjection', false);
        }

        if (!event || event.affectsConfiguration('virgo.agent.autoInjectSITREP')) {
            const val = config.get<boolean>('agent.autoInjectSITREP', true);
            updatedOptions.autoInjectSITREP = val;
            this.bridgeAgentState(val);
        }

        if (Object.keys(updatedOptions).length > 0) {
            this._stateStore.setOptions(updatedOptions);
            if (event) {
                this._logger(`[CONFIG_CHANGE] Syncing settings.json -> StateStore: ${JSON.stringify(updatedOptions)}`);
            }
        }
    }

    /**
     * Debounced save to VS Code Global configuration.
     * [SOFT_DEFAULT_GUARD]: Only updates the physical settings.json if the value has changed
     * compared to the current global configuration.
     */
    public saveSetting(key: string, value: any): void {
        // 1. Optimistic UI update in the StateStore (immediate)
        const storeKey = key === 'voice' ? 'selectedVoice' : key;
        const currentState = this._stateStore.state;
        
        // Prevent redundant state updates if the value matches the current store state
        if ((currentState as any)[storeKey] === value) {
            return;
        }

        this._stateStore.setOptions({ [storeKey]: value });

        // 2. Debounced persistence to VS Code configuration
        if (this._debounceTimers.has(key)) {
            clearTimeout(this._debounceTimers.get(key)!);
        }
        
        this._debounceTimers.set(key, setTimeout(async () => {
            const config = vscode.workspace.getConfiguration('virgo');
            const configKey = `playback.${key === 'selectedVoice' || key === 'voice' ? 'voice' : key}`;
            
            // [SOVEREIGNTY] Check if the value actually differs from the PERSISTED value
            // config.get() returns the merged value. config.inspect() gives us the global/workspace breakdown.
            const inspection = config.inspect(configKey);
            const currentGlobalValue = inspection?.globalValue;

            if (currentGlobalValue === value) {
                this._logger(`[CONFIG_SYNC] Skipping redundant update for ${configKey} (already matches global config: ${value})`);
                this._debounceTimers.delete(key);
                return;
            }

            try {
                await config.update(configKey, value, vscode.ConfigurationTarget.Global);
                this._logger(`[CONFIG_SYNC] Updated ${configKey} -> ${value}`);
            } catch (e) {
                this._logger(`[CONFIG_SYNC] FAILED to update ${configKey}: ${e}`);
            }
            this._debounceTimers.delete(key);
        }, 1000));
    }

    /**
     * Synchronizes a persistent setting to the Agent session's extension_state.json.
     */
    public bridgeAgentState(autoInjectSITREP: boolean): void {
        const stateFile = path.join(this._antigravityRoot, this._sessionId, 'extension_state.json');
        if (fs.existsSync(stateFile)) {
            try {
                const content = fs.readFileSync(stateFile, 'utf8');
                const state = JSON.parse(content);
                state.autoInjectSITREP = autoInjectSITREP;
                fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
                this._logger(`[BRIDGE] Synced autoInjectSITREP=${autoInjectSITREP} to ${this._sessionId}`);
            } catch (err) {
                this._logger(`[BRIDGE_ERROR] Failed to patch extension_state.json: ${err}`);
            }
        }
    }

    /**
     * Throttled persistence of document progress (chapter/sentence) to globalState.
     */
    public saveProgress(uri: vscode.Uri, salt?: string, hash?: string, chapterIndex: number = 0, sentenceIndex: number = 0): void {
        if (this._saveProgressTimer) { clearTimeout(this._saveProgressTimer); }
        this._saveProgressTimer = setTimeout(() => {
            const uriStr = uri.toString();
            const saltStr = salt ? `-${salt}` : '';
            const hashStr = hash ? `#${hash}` : '';
            const storageKey = `${uriStr}${saltStr}${hashStr}`;

            const progress = {
                chapterIndex,
                sentenceIndex,
                lastUpdated: Date.now()
            };

            const allProgress = this._context.globalState.get<Record<string, any>>('virgo.docProgress', {});

            // Decommission legacy URI-only key if it exists
            if (allProgress[uriStr]) { delete allProgress[uriStr]; }

            allProgress[storageKey] = progress;

            // Garbage Collection (Limit to 50 entries)
            const keys = Object.keys(allProgress);
            if (keys.length > 50) {
                const otherVersions = keys.filter(k => k.startsWith(uriStr) && k !== storageKey);
                if (otherVersions.length > 0) {
                    const oldestVersion = otherVersions.sort((a, b) => (allProgress[a].lastUpdated || 0) - (allProgress[b].lastUpdated || 0))[0];
                    delete allProgress[oldestVersion];
                } else {
                    const sortedKeys = keys.sort((a, b) => (allProgress[a].lastUpdated || 0) - (allProgress[b].lastUpdated || 0));
                    delete allProgress[sortedKeys[0]];
                }
            }

            this._context.globalState.update('virgo.docProgress', allProgress);
        }, 1000);
    }

    /**
     * Retrieves saved document progress from globalState.
     */
    public loadProgress(uri: vscode.Uri, salt?: string, hash?: string): { chapterIndex: number, sentenceIndex: number } | null {
        const allProgress = this._context.globalState.get<Record<string, any>>('virgo.docProgress', {});
        const uriStr = uri.toString();
        const saltStr = salt ? `-${salt}` : '';
        const hashStr = hash ? `#${hash}` : '';
        const storageKey = `${uriStr}${saltStr}${hashStr}`;

        let progress = allProgress[storageKey];

        // Passive migration from URI-only key
        if (!progress && allProgress[uriStr]) {
            progress = allProgress[uriStr];
            this._logger(`[MIGRATION] Found legacy progress for ${uri.path}. Upgrading to content-aware key.`);
        }

        return progress ? { chapterIndex: progress.chapterIndex, sentenceIndex: progress.sentenceIndex } : null;
    }

    private _migrateLegacySettings(): void {
        const legacyKeys = {
            'rate': 'playback.rate',
            'volume': 'playback.volume',
            'voice': 'playback.voice',
            'engineMode': 'playback.engineMode',
            'autoPlayMode': 'playback.autoPlayMode',
            'jumpDelayMs': 'playback.jumpDelayMs',
            'cacheMaxSizeMb': 'cache.maxSizeMb',
            'retryAttempts': 'network.retryAttempts'
        };

        const config = vscode.workspace.getConfiguration('virgo');
        let migratedAny = false;

        for (const [oldKey, newKey] of Object.entries(legacyKeys)) {
            const oldValue = this._context.globalState.get('virgo.' + oldKey);
            if (oldValue !== undefined) {
                config.update(newKey, oldValue, vscode.ConfigurationTarget.Global);
                this._context.globalState.update('virgo.' + oldKey, undefined);
                migratedAny = true;
                this._logger(`[MIGRATION] Moved ${oldKey} from globalState to settings.json (${newKey})`);
            }
        }

        if (migratedAny) {
            this._logger(`[MIGRATION] Legacy settings migration completed.`);
        }
    }

    public dispose(): void {
        this._debounceTimers.forEach(timer => clearTimeout(timer));
        this._debounceTimers.clear();
        if (this._saveProgressTimer) {
            clearTimeout(this._saveProgressTimer);
        }
    }
}

