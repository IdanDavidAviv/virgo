/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { SettingsDrawer } from '@webview/components/SettingsDrawer';
import { WebviewStore } from '@webview/core/WebviewStore';
import { WebviewAudioEngine } from '@webview/core/WebviewAudioEngine';

describe('Settings Interaction: Cache Clear (TDD)', () => {
    let store: WebviewStore;
    let engine: WebviewAudioEngine;

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset singletons for a clean TDD state
        WebviewStore.resetInstance();
        WebviewAudioEngine.resetInstance();
        
        store = WebviewStore.getInstance();
        engine = WebviewAudioEngine.getInstance();
    });

    it('SHOULD reset cache metrics and wipe audio engine on double-click', async () => {
        // 1. Initial State: Hydrate store with non-zero cache stats
        store.optimisticPatch({ 
            cacheCount: 20,
            cacheSizeBytes: 10485760 // 10MB
        });

        // 2. Setup Component
        const cacheDebugTag = document.createElement('span');
        cacheDebugTag.id = 'cache-status';
        
        // Mock the window.confirm to return true
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const wipeSpy = vi.spyOn(engine, 'wipeCache');
        const resetSpy = vi.spyOn(store, 'resetCacheStats');

        const drawer = new SettingsDrawer({
            cacheDebugTag: cacheDebugTag,
            // ... other elements as needed or partial mock
        } as any);
        
        drawer.mount();

        // 3. Simulate Double Click
        fireEvent.doubleClick(cacheDebugTag);

        // 4. Assert Expected Side Effects (Wait for async operations)
        await vi.waitFor(() => {
            expect(confirmSpy).toHaveBeenCalled();
            expect(wipeSpy).toHaveBeenCalled();
            expect(resetSpy).toHaveBeenCalled();
        }, { timeout: 1000 });

        // 5. Simulate Incoming IPC Update from Extension (Symmetry Test)
        store.updateUIState({ 
            neuralBuffer: { count: 0, sizeMb: 0 } 
        });

        // 6. Assert Final State matches UI state
        expect(store.getUIState().neuralBuffer.count).toBe(0);
        expect(store.getUIState().neuralBuffer.sizeMb).toBe(0);
    });
});
