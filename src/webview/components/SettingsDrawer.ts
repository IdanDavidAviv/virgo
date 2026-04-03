import { BaseComponent } from '../core/BaseComponent';
import { ToastManager } from './ToastManager';
import { CacheManager } from '../cacheManager';
import { MessageClient } from '../core/MessageClient';
import { OutgoingAction } from '../../common/types';
import { debounce } from '../utils';
import { WebviewAudioEngine } from '../core/WebviewAudioEngine';

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
    private cache = new CacheManager();
    private messenger = MessageClient.getInstance();
    private audioEngine = WebviewAudioEngine.getInstance();

    public mount(): void {
        super.mount();
        this.setupListeners();

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
                const displayRate = (1 + (rate / 10)).toFixed(1);
                this.els.rateVal.textContent = `${displayRate}x`;
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
        if (this.els.btnOpen) {
            this.els.btnOpen.addEventListener('click', (e) => {
                e.stopPropagation();
                console.log('[SETTINGS] Toggle requested');
                this.toggle();
            });
        }
        
        // Only bind close separately if it's a distinct element from btnOpen
        const closeEl = this.els.btnClose;
        if (closeEl && closeEl !== this.els.btnOpen) {
            closeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                this.close();
            });
        }

        // Sliders — set isDraggingSlider=true on drag start, false on release (#4)
        const debouncedVolume = debounce((val: number) => {
            this.messenger.postAction(OutgoingAction.VOLUME_CHANGED, { volume: val });
        }, 40);

        const debouncedRate = debounce((val: number) => {
            this.messenger.postAction(OutgoingAction.RATE_CHANGED, { rate: val });
        }, 40);

        if (this.els.volumeSlider) {
            this.els.volumeSlider.oninput = (e) => {
                this.store.updateUIState({ isDraggingSlider: true });
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (this.els.volumeVal) {
                    this.els.volumeVal.textContent = `${val}%`;
                }
                
                // Real-time audio engine update
                this.audioEngine.setVolume(val);
                debouncedVolume(val);
            };
            this.els.volumeSlider.onchange = (e) => {
                this.store.updateUIState({ isDraggingSlider: false });
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.messenger.postAction(OutgoingAction.VOLUME_CHANGED, { volume: val });
            };
        }

        if (this.els.rateSlider) {
            this.els.rateSlider.oninput = (e) => {
                this.store.updateUIState({ isDraggingSlider: true });
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (this.els.rateVal) {
                    const displayRate = (1 + (val / 10)).toFixed(1);
                    this.els.rateVal.textContent = `${displayRate}x`;
                }
                
                // Real-time audio engine update
                this.audioEngine.setRate(val);
                debouncedRate(val);
            };
            this.els.rateSlider.onchange = (e) => {
                this.store.updateUIState({ isDraggingSlider: false });
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

        // Cache Clear (v1.5.3: Double Click to prevent accidental resets)
        if (this.els.cacheDebugTag) {
            this.els.cacheDebugTag.ondblclick = async () => {
                const confirmed = confirm('Clear all cached neural audio?');
                if (confirmed) {
                    await this.cache.clearAll();
                    ToastManager.show('Audio cache cleared', 'info');
                    this.els.cacheDebugTag.classList.add('pulse');
                    setTimeout(() => this.els.cacheDebugTag.classList.remove('pulse'), 500);
                }
            };
            
            // Add a hint on single click
            this.els.cacheDebugTag.onclick = () => {
                ToastManager.show('Double-click to clear cache', 'info');
            };
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
