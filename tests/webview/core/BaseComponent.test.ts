/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseComponent } from '@webview/core/BaseComponent';
import { WebviewStore } from '@webview/core/WebviewStore';
import { MessageClient } from '@webview/core/MessageClient';
import { IncomingCommand } from '@common/types';
import { resetAllSingletons, wireDispatcher } from '../testUtils';

// Mock implementation for testing
class TestComponent extends BaseComponent<{ container: HTMLElement | null }> {
  public render() {
    if (this.els.container) {
      this.els.container.innerHTML = 'rendered';
    }
  }
  
  public testSubscribe(selector: any, listener: any) {
    this.subscribe(selector, listener);
  }
}

describe('BaseComponent', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="container"></div>';
    resetAllSingletons();
    wireDispatcher();
  });

  it('should initialize and validate elements', () => {
    const container = document.getElementById('container');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    const component = new TestComponent({ container });
    
    expect(component).toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should warn if elements are missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    new TestComponent({ container: null });
    
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Missing expected element'));
    warnSpy.mockRestore();
  });

  it('should call render on mount', () => {
    const container = document.getElementById('container');
    const component = new TestComponent({ container });
    
    component.mount();
    
    expect(container?.innerHTML).toBe('rendered');
  });

  it('should manage subscriptions and cleanup on unmount', () => {
    const store = WebviewStore.getInstance();
    const container = document.getElementById('container');
    const component = new TestComponent({ container });
    const listener = vi.fn();
    
    component.testSubscribe((state: any) => state.isPlaying, listener);
    
    // Trigger sync
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        isPlaying: true,
        state: { currentSentenceIndex: 0 }
      }
    }));
    
    expect(listener).toHaveBeenCalledWith(true);
    vi.clearAllMocks();
    
    component.unmount();
    
    // Trigger sync again
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        isPlaying: false
      }
    }));
    
    expect(listener).not.toHaveBeenCalled();
  });
});
