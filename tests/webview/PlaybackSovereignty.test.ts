/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetAllSingletons, getCoreSystems, createMockSyncPacket } from './testUtils';
import { OutgoingAction, AudioEngineEventType } from '../../src/common/types';

describe('Playback Sovereignty (v2.3.2)', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="btn-play"></div>'; // Minimal DOM for PlaybackController
        resetAllSingletons();
    });

    it('should enter sampling mode and suppress auto-advance when a voice is selected', async () => {
        const { store, controller, client, engine } = getCoreSystems();
        
        // 1. Setup initial state: playing sentence 0
        const syncPacket = createMockSyncPacket({
            isPlaying: true,
            currentSentenceIndex: 0,
            currentSentences: ['Sentence one.', 'Sentence two.']
        });
        store.patchState(syncPacket);

        // Mock engine local speak
        const speakLocalSpy = vi.spyOn(engine, 'speakLocal').mockResolvedValue();
        const stopSpy = vi.spyOn(engine, 'stop').mockResolvedValue();
        const postActionSpy = vi.spyOn(client, 'postAction');

        // 2. Select a new voice
        await controller.selectVoice('neural-voice-1');

        // Verify: Engine stopped, state updated, local speak triggered
        expect(stopSpy).toHaveBeenCalled();
        expect(store.getState().isSelectingVoice).toBe(true);
        expect(speakLocalSpy).toHaveBeenCalledWith('Sentence one.', 'neural-voice-1', expect.any(Number));
        expect(postActionSpy).toHaveBeenCalledWith(OutgoingAction.VOICE_CHANGED, expect.objectContaining({
            voice: 'neural-voice-1'
        }));

        // 3. Simulate audio ending while isSelectingVoice is true
        // We need to trigger the internal event handler
        (controller as any).handleEngineEvent({ 
            type: AudioEngineEventType.ENDED, 
            intentId: 100 
        });

        // Verify: SENTENCE_ENDED was NOT sent
        expect(postActionSpy).not.toHaveBeenCalledWith(OutgoingAction.SENTENCE_ENDED, expect.any(Object));
    });

    it('should commit to the new voice and resume normal playback when PLAY is pressed', async () => {
        const { store, controller, client } = getCoreSystems();
        
        // 1. Setup sampling state
        const syncPacket = createMockSyncPacket({
            isPlaying: false, 
            isSelectingVoice: true,
            currentSentenceIndex: 0,
            batchIntentId: 10 
        });
        store.patchState(syncPacket);

        const postActionSpy = vi.spyOn(client, 'postAction');

        // 2. Press PLAY (Commitment trigger)
        await controller.play();

        // Verify: isSelectingVoice cleared, batchIntentId incremented, PLAY sent
        expect(store.getState().isSelectingVoice).toBe(false);
        expect(store.getState().batchIntentId).toBeGreaterThan(10);
        expect(postActionSpy).toHaveBeenCalledWith(OutgoingAction.PLAY, expect.objectContaining({
            batchId: store.getState().batchIntentId
        }));
    });

    it('should clear isSelectingVoice on STOP', async () => {
        const { store, controller } = getCoreSystems();
        
        store.patchState({ isSelectingVoice: true });
        expect(store.getState().isSelectingVoice).toBe(true);

        await controller.stop();
        expect(store.getState().isSelectingVoice).toBe(false);
    });
});
