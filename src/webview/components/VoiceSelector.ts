import { BaseComponent } from '../core/BaseComponent';
import { MessageClient } from '../core/MessageClient';
import { OutgoingAction } from '../../common/types';

export interface VoiceSelectorElements extends Record<string, HTMLElement | HTMLInputElement | HTMLSelectElement | null | undefined> {
    container: HTMLElement;
    searchInput: HTMLInputElement;
    voiceList: HTMLElement;
    voiceSelect: HTMLSelectElement;
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
        if (this.els.voiceSelect) {
            this.els.voiceSelect.onchange = (e) => {
                const voiceId = (e.target as HTMLSelectElement).value;
                this.client.postAction(OutgoingAction.VOICE_CHANGED, { voiceId });
            };
        }

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
     * Internal rendering logic for the select box.
     */
    private renderVoiceList(voicesToUse: any[], selectedVoice: string | undefined, mode: string): void {
        if (!this.els.voiceSelect) {return;}
        
        this.els.voiceSelect.innerHTML = '';

        voicesToUse.forEach((v: any) => {
            const name = typeof v === 'string' ? v : v.name;
            const lang = typeof v === 'string' ? '' : v.lang;
            const id = typeof v === 'string' ? v : v.id;

            if (!this.searchTerm || name.toLowerCase().includes(this.searchTerm) || lang.toLowerCase().includes(this.searchTerm)) {
                const opt = document.createElement('option');
                opt.value = id;
                
                if (mode === 'neural') {
                    opt.textContent = `✨ ${name} ${lang ? `(${lang})` : ''}`;
                } else {
                    opt.textContent = name;
                }

                if (id === selectedVoice) { opt.selected = true; }
                this.els.voiceSelect.appendChild(opt);
            }
        });
    }
}
