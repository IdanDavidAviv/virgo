import { BaseComponent } from '../core/BaseComponent';
import { ToastManager } from './ToastManager';
import { PlaybackController } from '../playbackController';
import { MessageClient } from '../core/MessageClient';
import { OutgoingAction } from '../../common/types';

export interface SettingsDrawerElements extends Record<string, HTMLElement | HTMLInputElement | HTMLButtonElement | HTMLMediaElement | null | undefined> {
    drawer: HTMLElement;
    btnOpen: HTMLElement;           // accepts <span> or <button>
    btnClose?: HTMLElement | null;  // optional: fallback if main close not used
    btnRefreshVoices?: HTMLButtonElement | null;
    btnClosePopover?: HTMLButtonElement | null;
    volumeSlider: HTMLInputElement;
    rateSlider: HTMLInputElement;
    rateVal: HTMLElement | null;
    volumeVal: HTMLElement | null;
    cacheDebugTag: HTMLElement;
    stateDebugTag: HTMLElement;
    togglePhonikudEnabled?: HTMLInputElement | null;
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

        // 3. Engine Mode Sync - Segmented Pills toggle
        this.subscribe((state) => state.engineMode, (mode) => {
            if (this.els.stateDebugTag) {
                this.els.stateDebugTag.classList.toggle('neural-active', mode === 'neural');
            }
        });

        // 3.1 Phonikud Enabled Sync - Checkbox toggle
        this.subscribe((state) => state.phonikudEnabled, (enabled) => {
            if (this.els.togglePhonikudEnabled) {
                this.els.togglePhonikudEnabled.checked = !!enabled;
            }
        });

        // 4. Refresh State Sync (Animation handler)
        this.subscribeUI((ui) => ui.isLoadingVoices, (isLoading) => {
            if (this.els.btnRefreshVoices) {
                this.els.btnRefreshVoices.classList.toggle('spinning', isLoading);
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

        // Click outside popover to close it
        this.registerEventListener(document, 'click', (e) => {
            const target = e.target as HTMLElement;
            if (!target) {return;}
            const isOpen = this.els.drawer?.classList.contains('open');
            if (isOpen) {
                const clickedInsideDrawer = this.els.drawer?.contains(target);
                const clickedInsideBtnOpen = this.els.btnOpen?.contains(target) || this.els.btnOpen === target;
                if (!clickedInsideDrawer && !clickedInsideBtnOpen) {
                    this.close();
                }
            }
        });

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

        // 4. Refresh & Close Buttons
        if (this.els.btnRefreshVoices) {
            this.registerEventListener(this.els.btnRefreshVoices, 'click', (e) => {
                e.stopPropagation();
                controller.refreshVoices();
            });
        }

        if (this.els.btnClosePopover) {
            this.registerEventListener(this.els.btnClosePopover, 'click', (e) => {
                e.stopPropagation();
                this.close();
            });
        }

        // 6. Phonikud toggle change listener
        const { togglePhonikudEnabled } = this.els;
        if (togglePhonikudEnabled) {
            this.registerEventListener(togglePhonikudEnabled, 'change', (e) => {
                const enabled = (e.target as HTMLInputElement).checked;
                controller.setPhonikudEnabled(enabled);
            });
        }
    }

    public render(): void {
        // Initial sync handled by subscriptions
    }

    public open(): void {
        this.els.drawer?.classList.add('open');
    }

    public close(): void {
        this.els.drawer?.classList.remove('open');
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
