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
            state: {}
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
    });

    it('should subscribe to StateStore changes on creation', () => {
        expect(mockStateStore.on).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('should throttle multiple sync requests within 100ms', () => {
        syncManager.requestSync();
        syncManager.requestSync();
        syncManager.requestSync();

        expect(mockDashboardRelay.sync).not.toHaveBeenCalled();

        vi.advanceTimersByTime(100);

        expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);
    });

    it('should sync immediately when immediate flag is true', () => {
        syncManager.requestSync(true);
        expect(mockDashboardRelay.sync).toHaveBeenCalledTimes(1);
    });

    it('should buffer updates when the view is hidden', () => {
        mockView.visible = false;
        syncManager.requestSync();
        
        vi.advanceTimersByTime(100);
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
        const history = [{ id: '1' }];
        syncManager.requestSync(true, history);
        expect(mockDashboardRelay.sync).toHaveBeenCalledWith(history, expect.anything());
    });

    it('should clear timer on dispose', () => {
        syncManager.requestSync();
        syncManager.dispose();
        
        vi.advanceTimersByTime(100);
        expect(mockDashboardRelay.sync).not.toHaveBeenCalled();
    });
});
