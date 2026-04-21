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
                batchIntentId: 0,
                snippetHistory: [],
                activeSessionId: 'TEST-SESSION',
                activeContentHash: 'HASH-1',
                isHydrated: true,
                currentChapterIndex: 0
            }
        };

        mockDashboardRelay = {
            sync: vi.fn(),
            isPlaybackAuthorized: true
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

    it('should sync immediately when force flag is true', () => {
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
        mockView.visible = false;
        syncManager.requestSync();
        
        mockView.visible = true;
        syncManager.setView(mockView);

        expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);
        expect((syncManager as any)._needsSync).toBe(false);
    });

    it('should clear timer on dispose', () => {
        syncManager.requestSync();
        syncManager.dispose();
        
        vi.advanceTimersByTime(100);
        expect(mockDashboardRelay.sync).not.toHaveBeenCalled();
    });

    describe('Gate 5 Addendum — steady-state playback coalesce', () => {
        it('should suppress a redundant flush when packet hash is identical and isPlaying is true', () => {
            syncManager.setPlayingState(true);

            // First flush — passes and sets the hash
            syncManager.requestSync(true);
            expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);

            // Second flush — same state → hash matches → absorbed
            syncManager.requestSync(true);
            expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);
        });

        it('should allow a flush if isPlaying is false even with identical packet hash', () => {
            syncManager.setPlayingState(false);

            syncManager.requestSync(true);
            syncManager.requestSync(true);

            expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(2);
        });
    });
});
