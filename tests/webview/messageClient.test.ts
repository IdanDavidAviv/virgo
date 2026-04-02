/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageClient } from '@webview/core/messageClient';
import { IncomingCommand, OutgoingAction } from '@webview/types';

describe('MessageClient', () => {
  let mockVsCodeApi: any;

  beforeEach(() => {
    // Reset singleton if possible or mock the global vscode object
    mockVsCodeApi = {
      postMessage: vi.fn(),
    };
    (window as any).acquireVsCodeApi = vi.fn(() => mockVsCodeApi);

    // Clear any previous singleton instance
    MessageClient.resetInstance();
  });

  it('should be a singleton', () => {
    const instance1 = MessageClient.getInstance();
    const instance2 = MessageClient.getInstance();
    expect(instance1).toBe(instance2);
    expect((window as any).acquireVsCodeApi).toHaveBeenCalledTimes(1);
  });

  it('should post actions correctly', () => {
    const client = MessageClient.getInstance();
    const payload = { test: true };

    client.postAction(OutgoingAction.READY, payload);

    expect(mockVsCodeApi.postMessage).toHaveBeenCalledWith({
      command: OutgoingAction.READY,
      payload
    });
  });

  it('should route incoming commands to registered handlers', () => {
    const client = MessageClient.getInstance();
    const handler = vi.fn();
    const payload = { state: 'updated' };

    client.onCommand(IncomingCommand.UI_SYNC, handler);

    // Simulate incoming message
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        payload
      }
    }));

    expect(handler).toHaveBeenCalledWith(payload);
  });
});
