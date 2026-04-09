import { BaseComponent } from '../core/BaseComponent';
import { ToastManager } from './ToastManager';
import { PlaybackController } from '../playbackController';

export interface SettingsDrawerElements extends Record<string, HTMLElement | HTMLInputElement | HTMLButtonElement | HTMLMediaElement | null | undefined> {
    drawer: HTMLElement;
    btnOpen: HTMLElement;           // accepts <span> or <button>
    btnClose?: HTMLElement | null;  // optional: only bind if different from btnOpen
    volumeSlider: HTMLInputElement;
    rateSlider: HTMLInputElement;
    btnCloudEngine: HTMLButtonElement;
    btnLocalEngine: HTMLButtonElement;
    rateVal: HTMLElement | null;
    volumeVal: HTMLElement | null;
    cacheDebugTag: HTMLElement;
    stateDebugTag: HTMLElement;
    engineToggleGroup: HTMLElement | null;
    neuralPlayer?: HTMLMediaElement | null;
}

/**
 * SettingsDrawer: Manages volume, rate, engine toggles, and cache stats.
 * Reactive and encapsulated.
 */
export class SettingsDrawer extends BaseComponent<SettingsDrawerElements> {
    constructor(elements: SettingsDrawerElements) {
        super(elements);

        // 1. Volume State Sync — guard against feedback loop during drag
        this.subscribe((state) => state.volume, (volume) => {
            const isDragging = this.store.getUIState().isDraggingSlider;
            if (!isDragging && this.els.volumeSlider) {
                this.els.volumeSlider.value = String(volume);
            }
            if (this.els.volumeVal) {
                this.els.volumeVal.textContent = `${volume}%`;
            }
        });

        // 2. Rate State Sync — guard against feedback loop during drag
        this.subscribe((state) => state.rate, (rate) => {
            const isDragging = this.store.getUIState().isDraggingSlider;
            if (!isDragging && this.els.rateSlider) {
                this.els.rateSlider.value = String(rate);
            }
            if (this.els.rateVal) {
                this.els.rateVal.textContent = `${rate.toFixed(1)}x`;
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
                this.els.stateDebugTag.textContent = `[ V:${stats.vol} | R:${stats.rate.toFixed(1)}x ]`;
            }
        });
    }

    protected onMount(): void {
        const controller = PlaybackController.getInstance();
        const { btnOpen, btnClose, volumeSlider, rateSlider, btnCloudEngine, btnLocalEngine, cacheDebugTag } = this.els;

        // 1. Drawer Toggles
        if (btnOpen) {
            this.registerEventListener(btnOpen, 'click', (e) => {
                e.stopPropagation();
                this.toggle();
            });
        }
        
        if (btnClose && btnClose !== btnOpen) {
            this.registerEventListener(btnClose, 'click', (e) => {
                e.stopPropagation();
                this.close();
            });
        }

        // 2. Volume Slider
        if (volumeSlider) {
            this.registerEventListener(volumeSlider, 'input', (e) => {
                this.store.updateUIState({ isDraggingSlider: true });
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (this.els.volumeVal) {
                    this.els.volumeVal.textContent = `${val}%`;
                }
                controller.setVolume(val);
            });

            this.registerEventListener(volumeSlider, 'change', (e) => {
                this.store.updateUIState({ isDraggingSlider: false });
                const val = parseFloat((e.target as HTMLInputElement).value);
                controller.setVolume(val);
            });
        }

        // 3. Rate Slider
        if (rateSlider) {
            this.registerEventListener(rateSlider, 'input', (e) => {
                this.store.updateUIState({ isDraggingSlider: true });
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (this.els.rateVal) {
                    this.els.rateVal.textContent = `${val.toFixed(1)}x`;
                }
                controller.setRate(val);
            });

            this.registerEventListener(rateSlider, 'change', (e) => {
                this.store.updateUIState({ isDraggingSlider: false });
                const val = parseFloat((e.target as HTMLInputElement).value);
                controller.setRate(val);
            });
        }

        // 4. Engine Toggle
        if (btnCloudEngine) {
            this.registerEventListener(btnCloudEngine, 'click', () => {
                controller.setEngineMode('neural');
            });
        }

        if (btnLocalEngine) {
            this.registerEventListener(btnLocalEngine, 'click', () => {
                controller.setEngineMode('local');
            });
        }

        // 5. Cache Management
        if (cacheDebugTag) {
            this.registerEventListener(cacheDebugTag, 'dblclick', async () => {
                const confirmed = confirm('Clear all cached neural audio?');
                if (confirmed) {
                    controller.clearCache();
                    ToastManager.show('Audio cache cleared', 'info');
                    this.pulse(cacheDebugTag);
                }
            });
            
            this.registerEventListener(cacheDebugTag, 'click', () => {
                ToastManager.show('Double-click to clear cache', 'info');
            });
        }
    }

    public render(): void {
        // Initial sync handled by subscriptions
    }

    public open(): void {
        this.els.drawer?.classList.add('open');
        if (this.els.engineToggleGroup) {
            this.els.engineToggleGroup.style.display = 'flex';
        }
    }

    public close(): void {
        this.els.drawer?.classList.remove('open');
        if (this.els.engineToggleGroup) {
            this.els.engineToggleGroup.style.display = 'none';
        }
    }

    public toggle(): void {
        const isOpen = this.els.drawer?.classList.contains('open');
        if (isOpen) {
            this.close();
        } else {
            this.open();
        }
    }
}
