import { BaseComponent } from '../core/BaseComponent';
import { escapeHtml } from '../utils';
import { PlaybackController } from '../playbackController';

export interface FileContextElements extends Record<string, HTMLElement | HTMLButtonElement | null | undefined> {
    activeSlot: HTMLElement;
    activeFilename: HTMLElement;
    activeDir: HTMLElement;
    readerSlot: HTMLElement;
    readerFilename: HTMLElement;
    readerDir: HTMLElement;
    btnLoadFile: HTMLButtonElement;
    btnResetContext: HTMLButtonElement; 
    btnModeFile: HTMLButtonElement;
    btnModeSnippet: HTMLButtonElement;
    fileModeContainer: HTMLElement;
    snippetLookupContainer: HTMLElement;
    transferLayer: HTMLElement;
}

/**
 * FileContext: Manages the "FOCUSED" and "ACTIVE" file headers.
 * Replaces legacy updateContextSlot logic with reactive subscriptions.
 */
export class FileContext extends BaseComponent<FileContextElements> {
    private loadType: 'loading' | 'clearing' = 'loading';

    constructor(elements: FileContextElements) {
        super(elements);

        // 1. Focused File Sync
        this.subscribe((state) => ({
            uri: state.focusedDocumentUri,
            name: state.focusedFileName,
            dir: state.focusedRelativeDir,
            version: (state as any).focusedVersionSalt,
            isSupported: state.focusedIsSupported
        }), (info) => {
            if (this.els.activeSlot) {
                this.els.activeSlot.classList.toggle('active', !!info.uri);
                this.els.activeSlot.classList.toggle('unsupported', !info.isSupported);
            }

            if (this.els.activeFilename) {
                this.els.activeFilename.textContent = info.uri ? info.name : 'No Active File';
            }
            if (this.els.activeDir) {
                this.els.activeDir.textContent = info.dir ? `${info.dir} /` : '';
            }

            const ui = this.store.getUIState();
            if (this.els.btnLoadFile) {
                this.els.btnLoadFile.disabled = !info.isSupported || ui.isAwaitingSync;
            }
            if (this.els.btnResetContext) {
                this.els.btnResetContext.disabled = ui.isAwaitingSync;
            }
        });

        // 2. Active (Reading) File Sync
        this.subscribe((state) => ({
            uri: state.activeDocumentUri,
            name: state.activeFileName,
            dir: state.activeRelativeDir,
            version: (state as any).versionSalt
        }), () => {
            this.syncSlot();
        });

        // 3. Load Button Sync State
        this.subscribeUI((state) => state.isAwaitingSync, (isAwaiting) => {
            if (this.els.btnLoadFile) {
                this.els.btnLoadFile.disabled = isAwaiting;
                this.els.btnLoadFile.classList.toggle('is-loading', isAwaiting);
            }
            if (!isAwaiting && this.els.btnResetContext) {
                this.els.btnResetContext.disabled = false;
            }
            this.syncSlot(isAwaiting);
        });

        this.subscribe((state) => {
            return (state.activeDocumentUri !== state.focusedDocumentUri) && (state.focusedIsSupported ?? false);
        }, (isMismatch) => {
            if (this.els.btnLoadFile) {
                this.els.btnLoadFile.classList.toggle('mismatch', !!isMismatch);
            }
        });

        // 4. Mode Logic
        this.subscribeUI((state) => state.activeMode, (mode) => {
            const isSnippet = mode === 'SNIPPET';
            if (this.els.btnModeFile) {
                this.els.btnModeFile.classList.toggle('active', !isSnippet);
            }
            if (this.els.btnModeSnippet) {
                this.els.btnModeSnippet.classList.toggle('active', isSnippet);
            }
            
            if (this.els.fileModeContainer) {
                this.els.fileModeContainer.style.display = isSnippet ? 'none' : 'flex';
            }
            if (this.els.snippetLookupContainer) {
                this.els.snippetLookupContainer.style.display = isSnippet ? 'block' : 'none';
            }
            if (this.els.transferLayer) {
                this.els.transferLayer.style.display = isSnippet ? 'none' : 'flex';
            }
        });
    }

    protected onMount(): void {
        const controller = PlaybackController.getInstance();
        const { btnLoadFile, btnResetContext, btnModeFile, btnModeSnippet } = this.els;

        // 1. Interaction Listeners
        if (btnLoadFile) {
            this.registerEventListener(btnLoadFile, 'click', () => {
                this.loadType = 'loading';
                if (this.els.readerFilename) { this.els.readerFilename.textContent = 'Loading Document...'; }
                controller.loadDocument();
            });
        }

        if (btnResetContext) {
            this.registerEventListener(btnResetContext, 'click', () => {
                this.loadType = 'clearing';
                btnResetContext.disabled = true; 
                if (this.els.readerFilename) { this.els.readerFilename.textContent = 'Clearing...'; }
                
                this.store.updateUIState({ isAwaitingSync: true });
                controller.resetContext();
            });
        }

        // 2. Mode Toggles
        if (btnModeFile) {
            this.registerEventListener(btnModeFile, 'click', () => {
                controller.setMode('FILE');
            });
        }

        if (btnModeSnippet) {
            this.registerEventListener(btnModeSnippet, 'click', () => {
                controller.setMode('SNIPPET');
            });
        }
    }

    public render(): void {
        this.syncSlot();
    }

    private getFallbackText(forcedAwaiting?: boolean): string {
        const isAwaiting = forcedAwaiting !== undefined ? forcedAwaiting : this.store.getUIState().isAwaitingSync;
        if (isAwaiting) {
            return (this.loadType === 'clearing') ? 'Clearing...' : 'Loading Document...';
        }
        return 'No File Loaded';
    }

    private syncSlot(forcedAwaiting?: boolean): void {
        const state = this.store.getState();
        this.updateSlot(
            state.activeDocumentUri || undefined,
            this.els.readerFilename,
            this.els.readerDir,
            (state as any).versionSalt || undefined,
            state.activeFileName || undefined,
            state.activeRelativeDir || undefined,
            this.getFallbackText(forcedAwaiting)
        );
    }

    private updateSlot(
        uri: string | undefined,
        filenameEl: HTMLElement,
        dirEl: HTMLElement,
        version: string | undefined,
        precalcName: string | undefined,
        precalcDir: string | undefined,
        fallbackText: string
    ): void {
        if (!uri) {
            filenameEl.textContent = fallbackText;
            dirEl.textContent = '';
            if (this.els.readerSlot && filenameEl === this.els.readerFilename) {
                 this.els.readerSlot.classList.remove('active');
            }
            return;
        }

        const filename = precalcName || uri.split(/[\\\/]/).pop() || '';
        const dir = precalcDir !== undefined
            ? precalcDir
            : (uri.split(/[\\\/]/).length > 3 ? uri.split(/[\\\/]/).slice(-3).join('/') : '');

        const versionHtml = version ? `<span class="version-badge">${version}</span>` : '';
        filenameEl.innerHTML = `${escapeHtml(filename)}${versionHtml}`;
        dirEl.textContent = dir ? `${dir} /` : '';

        if (this.els.readerSlot && filenameEl === this.els.readerFilename) {
            this.els.readerSlot.classList.add('active');
        }
    }
}
