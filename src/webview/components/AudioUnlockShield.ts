import { BaseComponent } from '../core/BaseComponent';
import { WebviewStore } from '../core/WebviewStore';
import { WebviewAudioEngine } from '../core/WebviewAudioEngine';
import { PlaybackController } from '../playbackController';

export interface AudioUnlockShieldElements extends Record<string, HTMLElement | null> {
    container: HTMLElement | null;
}

/**
 * AudioUnlockShield Component: Premium glassmorphic overlay that appears 
 * when the browser blocks autoplay due to lack of user gesture.
 */
export class AudioUnlockShield extends BaseComponent<AudioUnlockShieldElements> {
    constructor(elements: AudioUnlockShieldElements) {
        super(elements);
        this.subscribeUI((state) => state.isAudioContextBlocked, () => this.render());
    }

    public mount(): void {
        super.mount();
        if (this.els.container) {
            this.els.container.onclick = () => {
                console.log('[AudioUnlockShield] Shield clicked - Unlocking Audio System');
                WebviewAudioEngine.getInstance().ensureAudioContext();
                
                // Once unlocked, if we have a pending playback intent, resume it.
                const controller = PlaybackController.getInstance();
                if (controller.getState().intent === 'PLAYING') {
                    controller.play();
                }
            };
        }
    }

    public render(): void {
        const { container } = this.els;
        if (!container) {return;}

        const isBlocked = this.store.getUIState().isAudioContextBlocked;
        container.classList.toggle('visible', isBlocked);
        
        if (isBlocked) {
            container.innerHTML = `
                <div class="shield-content">
                    <div class="shield-icon-container">
                        <span class="shield-icon">🛡️</span>
                    </div>
                    <div class="shield-text">
                        <div class="shield-title">Audio System Locked</div>
                        <div class="shield-description">
                            Browser policy requires a manual interaction to enable automatic playback in this session.
                        </div>
                        <div class="shield-hint">Click anywhere to activate</div>
                    </div>
                </div>
            `;
        } else {
            // Memory hygiene: Clear innerHTML when hidden to stop animations
            container.innerHTML = '';
        }
    }
}
