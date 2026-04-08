import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoiceManager } from '@vscode/VoiceManager';

// Mocks
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: vi.fn(() => ({
            get: vi.fn(),
            update: vi.fn()
        }))
    }
}));

describe('VoiceManager', () => {
    let voiceManager: VoiceManager;
    let mockPlaybackEngine: any;
    let mockStateStore: any;
    let mockDashboardRelay: any;
    let mockLogger: any;

    beforeEach(() => {
        mockPlaybackEngine = {
            getVoices: vi.fn().mockResolvedValue([
                { name: 'Neural Voice 1' }
            ])
        };
        mockStateStore = {
            state: { engineMode: 'local' },
            setVoices: vi.fn()
        };
        mockDashboardRelay = {
            broadcastVoices: vi.fn()
        };
        mockLogger = vi.fn();

        voiceManager = new VoiceManager(
            mockPlaybackEngine as any,
            mockStateStore as any,
            mockDashboardRelay as any,
            mockLogger
        );
    });

    it('should scan voices and update state store', async () => {
        await voiceManager.scanAndSync();

        expect(mockPlaybackEngine.getVoices).toHaveBeenCalled();
        expect(mockStateStore.setVoices).toHaveBeenCalledWith(
            [],
            [{ name: 'Neural Voice 1' }]
        );
    });

    it('should broadcast voices after scanning', async () => {
        await voiceManager.scanAndSync();

        expect(mockDashboardRelay.broadcastVoices).toHaveBeenCalledWith(
            [],
            [{ name: 'Neural Voice 1' }],
            'local'
        );
    });

    it('should handle failures gracefully', async () => {
        mockPlaybackEngine.getVoices.mockRejectedValue(new Error('Scan failed'));
        
        await voiceManager.scanAndSync();

        expect(mockLogger).toHaveBeenCalledWith(expect.stringContaining('CRITICAL FAILURE'));
    });
});
