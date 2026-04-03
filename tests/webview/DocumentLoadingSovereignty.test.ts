import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { IncomingCommand, UISyncPacket } from '../../src/common/types';

/**
 * @vitest-environment jsdom
 */

describe('Document Loading Sovereignty & Slot Isolation', () => {
    beforeEach(() => {
        WebviewStore.resetInstance();
        vi.useFakeTimers();
        // Fixed baseline time
        vi.setSystemTime(new Date(2024, 0, 1));
    });

    it('SLOT ISOLATION: optimistic loading should only affect the Reader slot', () => {
        const store = WebviewStore.getInstance();
        
        // 1. Initial State: Both slots populated
        store.updateState({
            state: {
                activeFileName: 'Active.md',
                activeDocumentUri: 'file:///active.md',
                focusedFileName: 'Focused.md',
                focusedDocumentUri: 'file:///focused.md'
            }
        } as any, 'remote');

        // 2. USER ACTION: Click "Load File" (Optimistic Patch)
        // This mimics the logic in FileContext.ts
        store.optimisticPatch({
            state: {
                activeFileName: 'Loading Document...',
                activeDocumentUri: 'loading' as any,
                focusedFileName: 'Focused.md', // Explicitly preserved in code
                focusedDocumentUri: 'file:///focused.md'
            } as any
        }, { isAwaitingSync: true, intentTimeout: 2000 });

        const state = store.getState()?.state;
        expect(state?.activeFileName).toBe('Loading Document...');
        expect(state?.activeDocumentUri).toBe('loading');
        
        // [VERIFIED] Focused slot remains stable
        expect(state?.focusedFileName).toBe('Focused.md');
        expect(state?.focusedDocumentUri).toBe('file:///focused.md');
    });

    it('SOVEREIGNTY WINDOW: stale null-syncs ignored for 2000ms during LOAD_DOCUMENT', () => {
        const store = WebviewStore.getInstance();
        
        // 1. Enter Optimistic Loading
        store.optimisticPatch({
            state: { activeFileName: 'Loading...', activeDocumentUri: 'loading' as any } as any
        }, { isAwaitingSync: true, intentTimeout: 2000 });

        // 2. STALE SYNC: Host sends heartbeat with NULL uri (hasn't processed load yet)
        const staleSync: Partial<UISyncPacket> = {
            state: { activeDocumentUri: null, activeFileName: null } as any
        };
        store.updateState(staleSync as UISyncPacket, 'remote');

        // [VERIFIED] Guard protects the "Loading..." placeholder
        expect(store.getState()?.state?.activeDocumentUri).toBe('loading');
        
        // 3. EXPIRE WINDOW: Advance 2500ms
        vi.advanceTimersByTime(2500);
        store.updateState(staleSync as UISyncPacket, 'remote');

        // [VERIFIED] After expiry, state is allowed to be null again if that's what host says
        expect(store.getState()?.state?.activeDocumentUri).toBe(null);
    });

    it('AUTO-BREAK: Real URIs from host overwrite placeholders immediately', () => {
        const store = WebviewStore.getInstance();
        
        // 1. Enter Optimistic Loading (2000ms guard)
        store.optimisticPatch({
            state: { activeFileName: 'Loading...', activeDocumentUri: 'loading' as any } as any
        }, { isAwaitingSync: true, intentTimeout: 2000 });

        // 2. SUCCESS SYNC: Host sends the actual loaded file URI
        const successSync: Partial<UISyncPacket> = {
            state: { 
                activeDocumentUri: 'file:///real-document.md', 
                activeFileName: 'real-document.md' 
            } as any
        };
        store.updateState(successSync as UISyncPacket, 'remote');

        // [VERIFIED] Sovereignty allows overwrite because URI is NOT null/loading
        expect(store.getState()?.state?.activeDocumentUri).toBe('file:///real-document.md');
        expect(store.getState()?.state?.activeFileName).toBe('real-document.md');
    });
});
