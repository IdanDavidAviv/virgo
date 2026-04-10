import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { SyncManager } from '@vscode/SyncManager';
import { StateStore } from '@core/stateStore';
import { DashboardRelay } from '@vscode/dashboardRelay';

// Mock vscode
vi.mock('vscode', () => ({
    Disposable: { from: vi.fn() }
}));

describe('SyncManager', () => {
    let syncManager: SyncManager;
    let mockStateStore: any;
    let mockDashboardRelay: any;
    let mockLogger: any;
    let mockView: any;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();

        mockStateStore = {
            on: vi.fn(),
            emit: vi.fn(),
            state: {
                playbackIntentId: 0,
                batchIntentId: 0
            },
            setPlaybackIntentId: vi.fn(),
            setBatchIntentId: vi.fn()
        };

        mockDashboardRelay = {
            sync: vi.fn()
        };

        mockLogger = vi.fn();

        syncManager = new SyncManager(
            mockStateStore as any,
            mockDashboardRelay as any,
            mockLogger
        );

        mockView = {
            visible: true,
            webview: {
                postMessage: vi.fn()
            }
        };

        syncManager.setView(mockView);
        vi.clearAllMocks();
    });

    it('should subscribe to StateStore changes on creation', () => {
        // We test a fresh instance to avoid beforeEach interference
        const localMockStateStore = { on: vi.fn() };
        new SyncManager(localMockStateStore as any, mockDashboardRelay as any, mockLogger);
        expect(localMockStateStore.on).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('should throttle multiple sync requests within 150ms', () => {
        syncManager.requestSync();
        syncManager.requestSync();
        syncManager.requestSync();

        expect(mockDashboardRelay.sync).not.toHaveBeenCalled();

        vi.advanceTimersByTime(150);
        
        expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);
    });

    it('should sync immediately when immediate flag is true', () => {
        syncManager.requestSync(true);
        expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);
    });

    it('should buffer updates when the view is hidden', () => {
        mockView.visible = false;
        syncManager.requestSync();
        
        vi.advanceTimersByTime(150);
        expect(mockDashboardRelay.sync).not.toHaveBeenCalled();
        expect((syncManager as any)._needsSync).toBe(true);
    });

    it('should flush buffered updates when the view becomes visible', () => {
        // 1. Hide view and request sync
        mockView.visible = false;
        syncManager.requestSync();
        
        // 2. Reveal view via setView
        mockView.visible = true;
        syncManager.setView(mockView);

        // Immediate flush expected
        expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);
        expect((syncManager as any)._needsSync).toBe(false);
    });

    it('should update activeSessionId and trigger immediate sync', () => {
        syncManager.setSessionId('NEW-SESSION');
        expect((syncManager as any)._activeSessionId).toBe('NEW-SESSION');
        expect(mockDashboardRelay.sync).toHaveBeenCalledWith(undefined, 'NEW-SESSION');
    });

    it('should carry through snippetHistory during flush', () => {
        const history = [{ id: '1', sessionName: 'Test Session', snippets: [] }];
        syncManager.requestSync(true, history as any);
        expect(mockDashboardRelay.sync).toHaveBeenCalledWith(history, 'SESSION-ID-MISSING');
    });

    it('should clear timer on dispose', () => {
        syncManager.requestSync();
        syncManager.dispose();
        
        vi.advanceTimersByTime(100);
        expect(mockDashboardRelay.sync).not.toHaveBeenCalled();
    });

    // ─── Gate 5 Addendum — Steady-State Playback Coalesce ────────────────────
    // Ref: startup_orchestration skill — Gate 5 Addendum (Observed: 2026-04-10)
    // During active playback, document observer ticks can cause identical UI_SYNC
    // flushes. The flush must be suppressed when packet content is state-equivalent
    // and isPlaying === true.

    describe('Gate 5 Addendum — steady-state playback coalesce', () => {
        it('should suppress a redundant flush when packet hash is identical and isPlaying is true', () => {
            // Set playing state BEFORE first flush so the hash guard activates from the start
            (syncManager as any)._isPlaying = true;

            // First flush — passes and sets the hash
            syncManager.requestSync(true);
            expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);

            // Second flush — same session + isPlaying = true → hash matches → absorbed
            syncManager.requestSync(true);
            expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1); // Still 1
        });

        it('should allow a flush if isPlaying is false even with identical packet hash', () => {
            (syncManager as any)._isPlaying = false;

            syncManager.requestSync(true);
            syncManager.requestSync(true);

            // Both flushes allowed when not playing
            expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(2);
        });

        it('should reset the hash guard and allow flush after intent changes', () => {
            (syncManager as any)._isPlaying = true;

            syncManager.requestSync(true); // First — passes, hash set
            syncManager.requestSync(true); // Second — suppressed

            // Intent changes (e.g. user clicks play)
            (syncManager as any)._lastFlushHash = '';

            syncManager.requestSync(true); // After reset — must pass
            expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(2); // 1st + post-reset
        });
    });
});

