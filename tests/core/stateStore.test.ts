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

    it('should initialize with correct default state', () => {
        const state = store.state;
        expect(state.activeFileName).toBe('No File Loaded');
        expect(state.currentSentenceIndex).toBe(0);
        expect(state.isPreviewing).toBe(false);
        expect(state.volume).toBe(50);
        expect(state.rate).toBe(0);
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
        expect(logger).toHaveBeenCalledWith('[STATE] full_reset_complete');
    });

    it('should update active document and progress atomically [ISSUE 25]', () => {
        const uri = { toString: () => 'file:///new.md' } as vscode.Uri;
        const initialProgress = { chapterIndex: 2, sentenceIndex: 5 };
        
        // Start from a dirty state
        store.setProgress(1, 10);
        store.setPlaybackStatus(true, false, false);
        
        store.setActiveDocument(uri, 'new.md', 'Project', 'v1', initialProgress);
        
        expect(store.state.activeDocumentUri).toBe(uri);
        expect(store.state.activeFileName).toBe('new.md');
        expect(store.state.currentChapterIndex).toBe(2);
        expect(store.state.currentSentenceIndex).toBe(5);
        expect(store.state.isPlaying).toBe(false); // Should be reset
        expect(store.state.isPaused).toBe(false);  // Should be reset
    });

    it('should reset progress to 0,0 when no initialProgress is provided', () => {
        const uri = { toString: () => 'file:///reset.md' } as vscode.Uri;
        
        // Start from a dirty state
        store.setProgress(5, 50);
        
        store.setActiveDocument(uri, 'reset.md', 'Project');
        
        expect(store.state.currentChapterIndex).toBe(0);
        expect(store.state.currentSentenceIndex).toBe(0);
    });
});
