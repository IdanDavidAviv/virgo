import { BaseComponent } from '../core/BaseComponent';
import { MessageClient } from '../core/MessageClient';
import { OutgoingAction } from '../../common/types';

export interface VoiceSelectorElements extends Record<string, HTMLElement | HTMLInputElement | null | undefined> {
    voiceList: HTMLElement;
    searchInput: HTMLInputElement;
}

/**
 * VoiceSelector: Manages the searchable voice list.
 * Filtered by engine mode (Local/Neural) and user search term.
 */
export class VoiceSelector extends BaseComponent<VoiceSelectorElements> {
    private client = MessageClient.getInstance();
    private searchTerm = '';

    public mount(): void {
        super.mount();
        this.setupListeners();

        // Subscribe to relevant state changes for list rendering
        this.subscribe((state) => ({
            available: state.availableVoices,
            selected: state.selectedVoice,
            mode: state.engineMode
        }), (info) => {
            if (info.available) {
                const list = info.mode === 'neural' ? info.available.neural : info.available.local;
                this.renderVoiceList(list, info.selected, info.mode);
            }
        });
    }

    private setupListeners(): void {
        // No manual change listener needed for div-based list; clicks handle it.

        if (this.els.searchInput) {
            this.els.searchInput.oninput = (e) => {
                this.searchTerm = (e.target as HTMLInputElement).value.toLowerCase();
                const state = this.store.getState();
                if (state && state.availableVoices) {
                    const list = state.engineMode === 'neural' ? state.availableVoices.neural : state.availableVoices.local;
                    this.renderVoiceList(list, state.selectedVoice, state.engineMode);
                }
            };
        }
    }

    public render(): void {
        // Initial sync handled by subscriptions
    }

    /**
     * Internal rendering logic for the custom premium list.
     */
    private renderVoiceList(voicesToUse: any[], selectedVoice: string | undefined, mode: string): void {
        if (!this.els.voiceList) { return; }
        
        this.els.voiceList.innerHTML = '';

        const filtered = voicesToUse.filter((v: any) => {
            const name = typeof v === 'string' ? v : v.name;
            const lang = typeof v === 'string' ? '' : v.lang;
            return !this.searchTerm || 
                   name.toLowerCase().includes(this.searchTerm) || 
                   lang.toLowerCase().includes(this.searchTerm);
        });

        if (filtered.length === 0) {
            this.els.voiceList.innerHTML = '<div class="voice-placeholder">No voices found</div>';
            return;
        }

        filtered.forEach((v: any) => {
            const name = typeof v === 'string' ? v : v.name;
            const lang = typeof v === 'string' ? '' : v.lang;
            const id = typeof v === 'string' ? v : v.id;

            const item = document.createElement('div');
            item.className = 'voice-item';
            if (id === selectedVoice) { item.classList.add('selected'); }

            const label = document.createElement('span');
            label.className = 'flex-1';
            
            if (mode === 'neural') {
                label.innerHTML = `<span class="sparkle">✨</span> ${name} ${lang ? `<small style="opacity:0.5; font-size:9px">(${lang})</small>` : ''}`;
            } else {
                label.textContent = name;
            }

            item.appendChild(label);
            
            item.onclick = () => {
                this.client.postAction(OutgoingAction.VOICE_CHANGED, { voiceId: id });
                // Optimistic UI update
                this.els.voiceList?.querySelectorAll('.voice-item').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
            };

            this.els.voiceList?.appendChild(item);
            
            // Scroll selected into view on first render
            if (id === selectedVoice) {
                setTimeout(() => item.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
            }
        });
    }
}
