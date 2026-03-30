import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateStore } from '@core/stateStore';
import * as vscode from 'vscode';

describe('StateStore', () => {
    let store: StateStore;
    const logger = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        store = new StateStore(logger);
    });

    it('should initialize with default empty state', () => {
        const state = store.state;
        expect(state.activeFileName).toBe('No File Loaded');
        expect(state.currentSentenceIndex).toBe(0);
        expect(state.isPreviewing).toBe(false);
    });

    it('should update active document correctly', () => {
        const uri = { toString: () => 'file:///test.md' } as vscode.Uri;
        store.setActiveDocument(uri, 'test.md', 'Project');
        
        expect(store.state.activeDocumentUri).toBe(uri);
        expect(store.state.activeFileName).toBe('test.md');
        expect(store.state.activeRelativeDir).toBe('Project');
        expect(logger).toHaveBeenCalled();
    });

    it('should update progress correctly', () => {
        store.setProgress(1, 10);
        expect(store.state.currentChapterIndex).toBe(1);
        expect(store.state.currentSentenceIndex).toBe(10);
    });

    it('should reset to initial state', () => {
        store.setActiveDocument({} as any, 'dirty.md', 'dirt');
        store.setProgress(5, 5);
        store.setPreviewing(true);
        
        store.reset();
        
        const state = store.state;
        expect(state.activeFileName).toBe('No File Loaded');
        expect(state.currentSentenceIndex).toBe(0);
        expect(state.isPreviewing).toBe(false);
        expect(logger).toHaveBeenCalledWith('[STATE] reset_complete');
    });
});
