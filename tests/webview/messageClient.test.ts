/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageClient } from '@webview/core/MessageClient';
import { IncomingCommand, OutgoingAction } from '@common/types';

describe('MessageClient', () => {
  let mockVsCodeApi: any;

  beforeEach(() => {
    (window as any).vscode = null;
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

    // MessageClient intentionally flattens payload into the top-level message object.
    expect(mockVsCodeApi.postMessage).toHaveBeenCalledWith({
      command: OutgoingAction.READY,
      test: true
    });
  });

  it('should route incoming commands with nested payload', () => {
    const client = MessageClient.getInstance();
    const handler = vi.fn();
    const payload = { state: 'updated' };

    client.onCommand(IncomingCommand.UI_SYNC, handler);

    // Simulate incoming message with nested payload
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        payload
      }
    }));

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('should route legacy spread-style incoming commands', () => {
    const client = MessageClient.getInstance();
    const handler = vi.fn();
    
    // Legacy structure from DashboardRelay.ts: { command: 'UI_SYNC', ...packet }
    const spreadPacket = {
      state: { currentChapterIndex: 5 },
      isPlaying: true
    };

    client.onCommand(IncomingCommand.UI_SYNC, handler);

    // Simulate incoming message with spread properties
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        ...spreadPacket
      }
    }));

    expect(handler).toHaveBeenCalledWith(spreadPacket);
  });
});
