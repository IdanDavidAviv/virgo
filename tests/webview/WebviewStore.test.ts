/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '@webview/core/WebviewStore';
import { IncomingCommand, UISyncPacket } from '@common/types';
import { resetAllSingletons, wireDispatcher } from './testUtils';

describe('WebviewStore', () => {
  beforeEach(() => {
    (window as any).vscode = null;
    (window as any).acquireVsCodeApi = vi.fn(() => ({
      postMessage: vi.fn()
    }));
    resetAllSingletons();
    wireDispatcher();
  });

  it('should hydrate state from UI_SYNC commands', () => {
    const store = WebviewStore.getInstance();
    const mockPacket: Partial<UISyncPacket> = {
      isPlaying: true,
      rate: 1.5,
      state: { currentChapterIndex: 1 } as any
    };

    // Simulate UI_SYNC message via window event (which MessageClient listens to)
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        state: { currentSentenceIndex: 0 },
        ...mockPacket
      }
    }));

    expect(store.getState()?.isPlaying).toBe(true);
    expect(store.getState()?.rate).toBe(1.5);
    expect(store.getState()?.state.currentChapterIndex).toBe(1);
  });

  it('should notify subscribers using selectors', () => {
    const store = WebviewStore.getInstance();
    const listener = vi.fn();
    
    // Subscribe to isPlaying
    store.subscribe((state) => state.isPlaying, listener);

    // Initial sync (listener called once)
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        state: { currentSentenceIndex: 0 },
        isPlaying: false,
        rate: 1.0
      }
    }));

    expect(listener).toHaveBeenCalledWith(false);
    vi.clearAllMocks();

    // Trigger sync with same isPlaying (should NOT notify)
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        state: { currentSentenceIndex: 0 },
        isPlaying: false,
        rate: 2.0
      }
    }));

    expect(listener).not.toHaveBeenCalled();

    // Trigger sync with changed isPlaying (should notify)
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        state: { currentSentenceIndex: 0 },
        isPlaying: true,
        rate: 2.0
      }
    }));

    expect(listener).toHaveBeenCalledWith(true);
  });

  it('should provide unsubscribe functionality', () => {
    const store = WebviewStore.getInstance();
    const listener = vi.fn();
    const unsubscribe = store.subscribe((state) => state.rate, listener);

    unsubscribe();

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        state: { currentSentenceIndex: 0 },
        rate: 3.0
      }
    }));

    expect(listener).not.toHaveBeenCalled();
  });

  it('should maintain default audio settings (rate: 0, volume: 50) if not provided', () => {
    const store = WebviewStore.getInstance();
    
    // Trigger sync without rate/volume
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        isPlaying: false,
        state: { currentSentenceIndex: 0 }
      }
    }));

    const state = store.getState();
    expect(state?.rate).toBe(0);
    expect(state?.volume).toBe(50);
  });
});
