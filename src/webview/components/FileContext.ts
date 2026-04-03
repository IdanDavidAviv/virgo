import { BaseComponent } from '../core/BaseComponent';
import { escapeHtml } from '../utils';
import { OutgoingAction } from '../../common/types';
import { LayoutManager } from '../core/LayoutManager';
import { WebviewStore } from '../core/WebviewStore';

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
            this.els.btnLoadFile.onclick = (e) => {
                const btn = e.currentTarget as HTMLButtonElement;
                btn.classList.add('pulse');
                btn.classList.add('is-loading'); // [PARITY] Added missing loading class
                setTimeout(() => btn.classList.remove('pulse'), 400);

                // [AUDIT] Move loading feedback to the Reader slot (Active file)
                // instead of overwriting the Focused file name.
                if (this.els.readerFilename) {
                    this.els.readerFilename.textContent = 'Loading Document...';
                }
                if (this.els.readerDir) {
                    this.els.readerDir.textContent = '';
                }

                this.postAction(OutgoingAction.LOAD_DOCUMENT);
                // Coordination via Central Layout Manager
                LayoutManager.getInstance().closeOverlays();
            };
        }

        if (this.els.btnClearReader) {
            this.els.btnClearReader.onclick = (e) => {
                const btn = e.currentTarget as HTMLButtonElement;
                btn.classList.add('pulse');
                setTimeout(() => btn.classList.remove('pulse'), 400);

                // Dashboard Parity: Snappy UI clearing before host roundtrip
                const store = WebviewStore.getInstance();
                store.optimisticPatch({
                    state: {
                        ...store.getState()?.state,
                        activeDocumentUri: null as any,
                        activeFileName: null as any
                    }
                } as any, { isAwaitingSync: true });

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
            
            if (this.els.activeSlot) {
                this.els.activeSlot.classList.toggle('active', !!info.uri);
                this.els.activeSlot.classList.toggle('unsupported', !info.isSupported);
            }

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

            if (this.els.readerSlot) {
                this.els.readerSlot.classList.toggle('active', !!info.uri);
            }
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
