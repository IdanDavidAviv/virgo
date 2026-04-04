import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateStore } from '@core/stateStore';

describe('StateStore: activeMode Sync', () => {
    let store: StateStore;
    const logger = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        store = new StateStore((msg) => logger(msg));
    });

    it('should initialize with activeMode: FILE', () => {
        expect(store.state.activeMode).toBe('FILE');
    });

    it('should transition to SNIPPET mode correctly', () => {
        store.setActiveMode('SNIPPET');
        expect(store.state.activeMode).toBe('SNIPPET');
        expect(logger).toHaveBeenCalledWith('[STATE] active_mode_updated: SNIPPET');
    });

    it('should transition back to FILE mode correctly', () => {
        store.setActiveMode('SNIPPET');
        store.setActiveMode('FILE');
        expect(store.state.activeMode).toBe('FILE');
        expect(logger).toHaveBeenCalledWith('[STATE] active_mode_updated: FILE');
    });

    it('should emit "change" event when mode is updated', () => {
        const changeHandler = vi.fn();
        store.on('change', changeHandler);
        
        store.setActiveMode('SNIPPET');
        
        expect(changeHandler).toHaveBeenCalledTimes(1);
        expect(changeHandler).toHaveBeenCalledWith(expect.objectContaining({
            activeMode: 'SNIPPET'
        }));
    });
});
