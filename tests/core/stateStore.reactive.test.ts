import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateStore } from '@core/stateStore';
import { EventEmitter } from 'events';

describe('StateStore (Reactive)', () => {
    let store: StateStore;
    const logger = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        store = new StateStore(logger);
    });

    it('should be an instance of EventEmitter', () => {
        expect(store).toBeInstanceOf(EventEmitter);
    });

    it('should emit "change" when setProgress is called', () => {
        const changeSpy = vi.fn();
        store.on('change', changeSpy);

        store.setProgress(1, 5);

        expect(changeSpy).toHaveBeenCalledTimes(1);
        expect(changeSpy).toHaveBeenCalledWith(store.state);
    });

    it('should emit "change" when setActiveDocument is called', () => {
        const changeSpy = vi.fn();
        store.on('change', changeSpy);

        store.setActiveDocument(undefined, 'test.md', '/');

        expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    it('should emit "change" when setFocusedFile is called', () => {
        const changeSpy = vi.fn();
        store.on('change', changeSpy);

        store.setFocusedFile(undefined, 'test.md', '/', true);

        expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    it('should emit "change" when setPlaybackStatus is called', () => {
        const changeSpy = vi.fn();
        store.on('change', changeSpy);

        store.setPlaybackStatus(true, false);

        expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    it('should emit "change" when setOptions is called', () => {
        const changeSpy = vi.fn();
        store.on('change', changeSpy);

        store.setOptions({ rate: 1.5 });

        expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    it('should emit "change" when reset is called', () => {
        const changeSpy = vi.fn();
        store.on('change', changeSpy);

        store.reset();

        expect(changeSpy).toHaveBeenCalledTimes(1);
    });
});
