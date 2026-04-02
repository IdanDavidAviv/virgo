import { BaseComponent } from '../core/BaseComponent';
import { escapeHtml } from '../utils';
import { OutgoingAction } from '../../common/types';

export interface FileContextElements extends Record<string, HTMLElement | HTMLButtonElement | null | undefined> {
    activeSlot: HTMLElement;
    activeFilename: HTMLElement;
    activeDir: HTMLElement;
    readerSlot: HTMLElement;
    readerFilename: HTMLElement;
    readerDir: HTMLElement;
    btnLoadFile: HTMLButtonElement;
    btnClearReader?: HTMLButtonElement;
}

/**
 * FileContext: Manages the "FOCUSED" and "ACTIVE" file headers.
 * Replaces legacy updateContextSlot logic with reactive subscriptions.
 */
export class FileContext extends BaseComponent<FileContextElements> {
    
    public mount(): void {
        super.mount();

        // 0. Interaction Listeners
        if (this.els.btnLoadFile) {
            this.els.btnLoadFile.onclick = () => {
                this.postAction(OutgoingAction.LOAD_DOCUMENT);
            };
        }

        if (this.els.btnClearReader) {
            this.els.btnClearReader.onclick = () => {
                this.postAction(OutgoingAction.RESET_CONTEXT);
            };
        }

        // 1. Focused File Sync
        this.subscribe((state) => ({
            uri: state.state.focusedDocumentUri,
            name: state.state.focusedFileName,
            dir: state.state.focusedRelativeDir,
            version: state.state.focusedVersionSalt,
            isSupported: state.state.focusedIsSupported
        }), (info) => {
            this.updateSlot(
                info.uri || undefined, 
                this.els.activeFilename, 
                this.els.activeDir, 
                info.version || undefined, 
                info.name || undefined, 
                info.dir || undefined,
                'No Selection'
            );
            
            if (this.els.btnLoadFile) {
                this.els.btnLoadFile.disabled = !info.isSupported;
            }
        });

        // 2. Active (Reading) File Sync
        this.subscribe((state) => ({
            uri: state.state.activeDocumentUri,
            name: state.state.activeFileName,
            dir: state.state.activeRelativeDir,
            version: state.state.versionSalt
        }), (info) => {
            this.updateSlot(
                info.uri || undefined, 
                this.els.readerFilename, 
                this.els.readerDir, 
                info.version || undefined, 
                info.name || undefined, 
                info.dir || undefined,
                'No File Loaded'
            );
        });

        // 3. Load Button Mismatch Sync
        this.subscribe((state) => {
            return (state.state.activeDocumentUri !== state.state.focusedDocumentUri) && state.state.focusedIsSupported;
        }, (isMismatch) => {
            if (this.els.btnLoadFile) {
                this.els.btnLoadFile.classList.toggle('mismatch', !!isMismatch);
            }
        });
    }

    public render(): void {
        // Initial sync handled by subscriptions
    }

    /**
     * Internal slot update logic (derived from legacy updateContextSlot)
     */
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
            return;
        }

        const filename = precalcName || uri.split(/[\\\/]/).pop() || '';
        const dir = precalcDir !== undefined 
            ? precalcDir 
            : (uri.split(/[\\\/]/).length > 3 ? uri.split(/[\\\/]/).slice(-3).join('/') : '');

        const versionHtml = version ? `<span class="version-badge">${version}</span>` : '';
        filenameEl.innerHTML = `${escapeHtml(filename)}${versionHtml}`;
        dirEl.textContent = dir ? `${dir} /` : '';
    }
}
