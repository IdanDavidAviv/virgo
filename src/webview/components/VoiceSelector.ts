import { BaseComponent } from '../core/BaseComponent';
import { PlaybackController } from '../playbackController';
import { OutgoingAction } from '../../common/types';

export interface VoiceSelectorElements extends Record<string, HTMLElement | HTMLInputElement | null | undefined> {
    voiceList: HTMLElement;
    searchInput: HTMLInputElement;
    autoplayToggle?: HTMLInputElement;
    autoplayVoiceToggle?: HTMLInputElement;
}

/**
 * VoiceSelector: Manages the searchable voice list.
 * Filtered by engine mode (Local/Neural) and user search term.
 */
export class VoiceSelector extends BaseComponent<VoiceSelectorElements> {
    private searchTerm = '';

    constructor(elements: VoiceSelectorElements) {
        super(elements);

        // 1. Subscribe to relevant state changes for list rendering
        this.subscribe((state) => ({
            available: state.availableVoices,
            selected: state.selectedVoice,
            recent: state.recentVoices
        }), (info) => {
            if (info.available) {
                // Merge lists: Neural first, then Local
                const mergedList = [
                    ...(info.available.neural || []).map(v => ({ ...v, isNeural: true })),
                    ...(info.available.local || []).map(v => ({ ...v, isNeural: false }))
                ];
                this.renderVoiceList(mergedList, info.selected);
            }
        });

        // 2. Loading state feedback
        this.subscribeUI((ui) => ui.isLoadingVoices, (loading) => {
            if (loading && this.els.voiceList) {
                this.els.voiceList.innerHTML = '<div class="voice-placeholder animate-pulse">Loading optimized voices...</div>';
            }
        });

        // 3. Subscribe to Autoplay Toggles state changes
        this.subscribe((state) => ({
            autoPlayOnInjection: state.autoPlayOnInjection,
            autoPlayOnVoiceSelect: state.autoPlayOnVoiceSelect
        }), (info) => {
            if (this.els.autoplayToggle) {
                this.els.autoplayToggle.checked = !!info.autoPlayOnInjection;
            }
            if (this.els.autoplayVoiceToggle) {
                this.els.autoplayVoiceToggle.checked = !!info.autoPlayOnVoiceSelect;
            }
        });
    }

    protected onMount(): void {
        const { searchInput, voiceList, autoplayToggle, autoplayVoiceToggle } = this.els;

        // 1. Search Input delegation
        if (searchInput) {
            this.registerEventListener(searchInput, 'input', (e) => {
                this.searchTerm = (e.target as HTMLInputElement).value.toLowerCase();
                const state = this.store.getState();
                if (state && state.availableVoices) {
                    const mergedList = [
                        ...(state.availableVoices.neural || []).map(v => ({ ...v, isNeural: true })),
                        ...(state.availableVoices.local || []).map(v => ({ ...v, isNeural: false }))
                    ];
                    this.renderVoiceList(mergedList, state.selectedVoice);
                }
            });
        }

        // 2. Voice List delegation
        if (voiceList) {
            this.registerEventListener(voiceList, 'click', (e) => {
                const item = (e.target as HTMLElement).closest('.voice-item') as HTMLElement;
                if (!item) { return; }

                const id = item.dataset.id;
                if (!id) { return; }

                this.pulse(item);

                // [DELEGATION] All authority moved to PlaybackController
                PlaybackController.getInstance().selectVoice(id);
            });
        }

        // 3. Autoplay Toggles
        if (autoplayToggle) {
            this.registerEventListener(autoplayToggle, 'change', (e) => {
                const val = (e.target as HTMLInputElement).checked;
                this.postAction(OutgoingAction.SET_AUTOPLAY_INJECTION, { value: val });
            });
        }

        if (autoplayVoiceToggle) {
            this.registerEventListener(autoplayVoiceToggle, 'change', (e) => {
                const val = (e.target as HTMLInputElement).checked;
                this.postAction(OutgoingAction.SET_AUTOPLAY_VOICE_SELECT, { value: val });
            });
        }
    }

    public render(): void {
        // Initial sync handled by subscriptions
    }

    /**
     * Internal rendering logic for the custom premium list.
     */
    private renderVoiceList(voicesToUse: any[], selectedVoice: string | undefined): void {
        const { isLoadingVoices } = this.store.getUIState();
        if (!this.els.voiceList || isLoadingVoices) { return; }

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

        const recentIds = this.store.getState().recentVoices || [];
        const recentVoices = filtered.filter(v => recentIds.includes(typeof v === 'string' ? v : v.id));
        const otherVoices = filtered.filter(v => !recentIds.includes(typeof v === 'string' ? v : v.id));

        const createVoiceItem = (v: any, isRecentItem = false) => {
            const name = typeof v === 'string' ? v : v.name;
            const lang = typeof v === 'string' ? '' : v.lang;
            const id = typeof v === 'string' ? v : v.id;
            const isNeural = v.isNeural;

            const item = document.createElement('div');
            item.className = 'voice-item';
            item.dataset.id = id;
            if (id === selectedVoice) { item.classList.add('selected'); }

            const label = document.createElement('span');
            label.className = 'flex-1';

            if (isNeural) {
                label.innerHTML = `<span class="sparkle">✨</span> ${name} ${lang ? `<small style="opacity:0.5; font-size:9px">(${lang})</small>` : ''}`;
            } else {
                label.textContent = name;
            }
            item.appendChild(label);

            if (isRecentItem) {
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'btn-delete-recent';
                deleteBtn.innerHTML = '&times;';
                deleteBtn.title = 'Remove from recent';
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.postAction(OutgoingAction.REMOVE_RECENT_VOICE, { voice: id });
                });
                item.appendChild(deleteBtn);
            }

            return item;
        };

        // Render Recent Voices Group
        if (recentVoices.length > 0) {
            const header = document.createElement('div');
            header.className = 'voice-group-header';
            header.textContent = 'Recently Used';
            this.els.voiceList.appendChild(header);

            recentVoices.forEach(v => {
                const item = createVoiceItem(v, true);
                this.els.voiceList?.appendChild(item);
                if ((typeof v === 'string' ? v : v.id) === selectedVoice) {
                    setTimeout(() => item.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), 50);
                }
            });
        }

        // Render All Other Voices
        if (otherVoices.length > 0) {
            if (recentVoices.length > 0) {
                const header = document.createElement('div');
                header.className = 'voice-group-header';
                header.textContent = 'All Voices';
                this.els.voiceList.appendChild(header);
            }

            otherVoices.forEach(v => {
                const item = createVoiceItem(v, false);
                this.els.voiceList?.appendChild(item);
                if ((typeof v === 'string' ? v : v.id) === selectedVoice) {
                    setTimeout(() => item.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), 50);
                }
            });
        }
    }
}
