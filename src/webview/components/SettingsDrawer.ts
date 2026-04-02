import { BaseComponent } from '../core/BaseComponent';
import { ToastManager } from './ToastManager';
import { CacheManager } from '../cacheManager';
import { MessageClient } from '../core/messageClient';
import { OutgoingAction } from '../../common/types';

export interface SettingsDrawerElements extends Record<string, HTMLElement | HTMLInputElement | HTMLButtonElement | HTMLMediaElement | null | undefined> {
    drawer: HTMLElement;
    btnOpen: HTMLButtonElement;
    btnClose: HTMLButtonElement;
    volumeSlider: HTMLInputElement;
    rateSlider: HTMLInputElement;
    btnCloudEngine: HTMLButtonElement;
    btnLocalEngine: HTMLButtonElement;
    cacheDebugTag: HTMLElement;
    stateDebugTag: HTMLElement;
    engineToggleGroup: HTMLElement | null;
    neuralPlayer: HTMLMediaElement | null;
}

/**
 * SettingsDrawer: Manages volume, rate, engine toggles, and cache stats.
 * Reactive and encapsulated.
 */
export class SettingsDrawer extends BaseComponent<SettingsDrawerElements> {
    private isDraggingSlider = false;
    private cache = new CacheManager();
    private messenger = MessageClient.getInstance();

    public mount(): void {
        super.mount();
        this.setupListeners();

        // 1. Volume State Sync — guard against feedback loop during drag (#4)
        this.subscribe((state) => state.volume, (volume) => {
            if (!this.isDraggingSlider && this.els.volumeSlider) {
                this.els.volumeSlider.value = String(volume);
            }
        });

        // 2. Rate State Sync — guard against feedback loop during drag (#4)
        this.subscribe((state) => state.rate, (rate) => {
            if (!this.isDraggingSlider && this.els.rateSlider) {
                this.els.rateSlider.value = String(rate);
            }
        });

        // 3. Engine Mode Sync
        this.subscribe((state) => state.engineMode, (mode) => {
            if (this.els.btnCloudEngine && this.els.btnLocalEngine) {
                this.els.btnCloudEngine.classList.toggle('active', mode === 'neural');
                this.els.btnLocalEngine.classList.toggle('active', mode === 'local');
            }
        });

        // 4. Cache Stats Sync
        this.subscribe((state) => ({ count: state.cacheCount, size: state.cacheSizeBytes }), (stats) => {
            if (this.els.cacheDebugTag) {
                const mb = (stats.size / (1024 * 1024)).toFixed(1);
                this.els.cacheDebugTag.textContent = `[ CACHE: ${stats.count}/100 | ${mb}MB ]`;
            }
        });

        // 5. Global State Debug (V/R Tooltip)
        this.subscribe((state) => ({ vol: state.volume, rate: state.rate }), (stats) => {
            if (this.els.stateDebugTag) {
                const displayRate = (1 + (stats.rate / 10)).toFixed(1);
                this.els.stateDebugTag.textContent = `[ V:${stats.vol} | R:${displayRate}x ]`;
            }
        });
    }

    private setupListeners(): void {
        // Drawer Toggle — also syncs engineToggleGroup visibility (#6)
        const toggleDrawer = (open: boolean) => {
            if (open) {
                this.els.drawer?.classList.add('open');
            } else {
                this.els.drawer?.classList.remove('open');
            }
            if (this.els.engineToggleGroup) {
                (this.els.engineToggleGroup as HTMLElement).style.display = open ? 'flex' : 'none';
            }
        };

        if (this.els.btnOpen) {
            this.els.btnOpen.onclick = () => {
                const isOpen = this.els.drawer?.classList.contains('open');
                toggleDrawer(!isOpen);
            };
        }
        if (this.els.btnClose) {
            this.els.btnClose.onclick = () => toggleDrawer(false);
        }

        // Sliders — set isDraggingSlider=true on drag start, false on release (#4)
        if (this.els.volumeSlider) {
            this.els.volumeSlider.oninput = (e) => {
                this.isDraggingSlider = true;
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.messenger.postAction(OutgoingAction.VOLUME_CHANGED, { volume: val });
            };
            this.els.volumeSlider.onchange = (e) => {
                this.isDraggingSlider = false;
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.messenger.postAction(OutgoingAction.VOLUME_CHANGED, { volume: val });
            };
        }

        if (this.els.rateSlider) {
            this.els.rateSlider.oninput = (e) => {
                this.isDraggingSlider = true;
                const val = parseFloat((e.target as HTMLInputElement).value);
                // Live playbackRate preview on the audio element (#8)
                if (this.els.neuralPlayer && !(this.els.neuralPlayer as HTMLMediaElement).paused) {
                    (this.els.neuralPlayer as HTMLMediaElement).playbackRate =
                        val >= 0 ? 1 + (val / 10) : 1 + (val / 20);
                }
                this.messenger.postAction(OutgoingAction.RATE_CHANGED, { rate: val });
            };
            this.els.rateSlider.onchange = (e) => {
                this.isDraggingSlider = false;
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.messenger.postAction(OutgoingAction.RATE_CHANGED, { rate: val });
            };
        }

        // Engine Toggle
        if (this.els.btnCloudEngine) {
            this.els.btnCloudEngine.onclick = () => {
                this.messenger.postAction(OutgoingAction.ENGINE_MODE_CHANGED, { mode: 'neural' });
            };
        }

        if (this.els.btnLocalEngine) {
            this.els.btnLocalEngine.onclick = () => {
                this.messenger.postAction(OutgoingAction.ENGINE_MODE_CHANGED, { mode: 'local' });
            };
        }

        // Cache Clear
        if (this.els.cacheDebugTag) {
            this.els.cacheDebugTag.onclick = async () => {
                const confirmed = confirm('Clear all cached neural audio?');
                if (confirmed) {
                    await this.cache.clearAll();
                    ToastManager.show('Audio cache cleared', 'info');
                    this.els.cacheDebugTag.classList.add('pulse');
                    setTimeout(() => this.els.cacheDebugTag.classList.remove('pulse'), 500);
                }
            };
        }
    }

    public render(): void {
        // Initial sync handled by subscriptions
    }
}
