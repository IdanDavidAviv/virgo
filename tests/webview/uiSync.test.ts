import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcilePlaybackUI } from '@webview/uiManager';


/**
 * @vitest-environment jsdom
 */
describe('UIManager - reconcilePlaybackUI', () => {
    let elements: any;
    let controller: any;

    beforeEach(() => {
        elements = {
            btnPlay: { style: {}, classList: { toggle: vi.fn() } },
            btnPause: { style: {}, classList: { toggle: vi.fn() } },
            waveContainer: { classList: { toggle: vi.fn() } }
        };
        controller = {
            getState: vi.fn(() => ({ isAwaitingSync: false }))
        };
    });

    it('should show Play and hide Pause when not playing', () => {
        const state = { isPlaying: false, isPaused: false };
        reconcilePlaybackUI(state, elements, controller);

        expect(elements.btnPlay.style.display).toBe('flex');
        expect(elements.btnPause.style.display).toBe('none');
    });

    it('should show Pause and hide Play when playing', () => {
        const state = { isPlaying: true, isPaused: false };
        reconcilePlaybackUI(state, elements, controller);

        expect(elements.btnPlay.style.display).toBe('none');
        expect(elements.btnPause.style.display).toBe('flex');
    });

    it('should apply is-loading when controller is awaiting sync', () => {
        controller.getState.mockReturnValue({ isAwaitingSync: true });
        const state = { isPlaying: false, isPaused: false, playbackStalled: false };
        
        reconcilePlaybackUI(state, elements, controller);

        expect(elements.btnPlay.classList.toggle).toHaveBeenCalledWith('is-loading', true);
        expect(elements.btnPause.classList.toggle).toHaveBeenCalledWith('is-loading', true);
    });

    it('should apply is-loading when engine reports stall', () => {
        controller.getState.mockReturnValue({ isAwaitingSync: false });
        const state = { isPlaying: true, isPaused: false, playbackStalled: true };
        
        reconcilePlaybackUI(state, elements, controller);

        expect(elements.btnPlay.classList.toggle).toHaveBeenCalledWith('is-loading', true);
        expect(elements.btnPause.classList.toggle).toHaveBeenCalledWith('is-loading', true);
        expect(elements.waveContainer.classList.toggle).toHaveBeenCalledWith('stalled', true);
    });

    it('should remove is-loading when neither stalled nor awaiting sync', () => {
        controller.getState.mockReturnValue({ isAwaitingSync: false });
        const state = { isPlaying: true, isPaused: false, playbackStalled: false };
        
        reconcilePlaybackUI(state, elements, controller);

        expect(elements.btnPlay.classList.toggle).toHaveBeenCalledWith('is-loading', false);
        expect(elements.btnPause.classList.toggle).toHaveBeenCalledWith('is-loading', false);
    });
});

