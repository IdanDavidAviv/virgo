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
        mockStateStore.state.playbackIntentId = 2;
        syncManager.requestSync();
        mockStateStore.state.playbackIntentId = 3;
        syncManager.requestSync();

        expect(mockDashboardRelay.sync).not.toHaveBeenCalled();

        vi.advanceTimersByTime(150);
        
        expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);
    });

    it('should sync immediately when force flag is true', () => {
        mockStateStore.state.playbackIntentId = 42; // Avoid deduplication
        syncManager.requestSync(true);
        expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);
    });

    it('should buffer updates when the view is hidden', () => {
        mockView.visible = false;
        mockStateStore.state.playbackIntentId = 99; // Change state to bypass hash
        syncManager.requestSync();
        
        vi.advanceTimersByTime(150);
        expect(mockDashboardRelay.sync).not.toHaveBeenCalled();
        expect((syncManager as any)._needsSync).toBe(true);
    });

    it('should flush buffered updates when the view becomes visible', () => {
        mockView.visible = false;
        mockStateStore.state.playbackIntentId = 143; // Bypass hash
        syncManager.requestSync();
        
        mockView.visible = true;
        mockStateStore.state.playbackIntentId = 144; // Bypass hash on setView
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
            mockStateStore.state.isPlaying = true;

            // First flush — passes and sets the hash
            syncManager.requestSync(true);
            expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);

            // Second flush — same state → hash matches → absorbed
            syncManager.requestSync(true);
            expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);
        });

        it('should absorb a flush if isPlaying is false and hash is identical', () => {
            mockStateStore.state.isPlaying = false;
            // Clear prior hashes to simulate fresh run
            (syncManager as any)._lastFlushHash = undefined;

            syncManager.requestSync(true); // first flush passes
            syncManager.requestSync(true); // second flush identical, absorbed

            expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);
        });
    });
});
