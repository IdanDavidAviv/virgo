/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

    // Simulate incoming message with flat payload
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        payload: {
          ...payload,
          currentChapterIndex: 0,
          currentSentenceIndex: 0,
          volume: 50,
          rate: 0,
          allChapters: [],
          currentSentences: [],
          snippetHistory: []
        }
      }
    }));

    expect(handler).toHaveBeenCalledWith({
      ...payload,
      currentChapterIndex: 0,
      currentSentenceIndex: 0,
      volume: 50,
      rate: 0,
      allChapters: [],
      currentSentences: [],
      snippetHistory: []
    });
  });

  it('should route incoming commands with flat properties', () => {
    const client = MessageClient.getInstance();
    const handler = vi.fn();
    // All packets are now flat.
    const flatPacket = {
      currentChapterIndex: 5,
      isPlaying: true
    };

    client.onCommand(IncomingCommand.UI_SYNC, handler);

    // Simulate incoming message with flat properties
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        command: IncomingCommand.UI_SYNC,
        ...flatPacket
      }
    }));

    expect(handler).toHaveBeenCalledWith({
      ...flatPacket,
      currentSentenceIndex: 0,
      volume: 50,
      rate: 0,
      allChapters: [],
      currentSentences: [],
      snippetHistory: []
    });
  });

  describe('Tiered Logging', () => {
    let mockLog: any;

    beforeEach(() => {
      mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      mockLog.mockRestore();
    });

    it('should summarize large data in STANDARD mode (default)', () => {
      const client = MessageClient.getInstance();
      const largePayload = { 
        text: 'This is a test string that is definitely longer than fifty characters long.',
        list: Array(100).fill('item')
      };

      client.postAction(OutgoingAction.READY, largePayload);

      const lastLog = mockLog.mock.calls[mockLog.mock.calls.length - 1][0];
      expect(lastLog).toContain('[ACTION] ready');
      expect(lastLog).toContain('This is a test string');
      expect(lastLog).toContain('...');
      expect(lastLog).toContain('[Array(100)]');
    });

    it('should log raw data in VERBOSE mode after receiving VERBOSE LogLevel', () => {
      const client = MessageClient.getInstance();
      const largePayload = { 
        text: 'A very long text that exceeds the fifty character limit for summarization',
        list: Array(10).fill('item')
      };

      // 1. Sync VERBOSE level
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          command: IncomingCommand.UI_SYNC,
          logLevel: 2 // VERBOSE
        }
      }));

      // 2. Post action
      client.postAction(OutgoingAction.READY, largePayload);

      const lastLog = mockLog.mock.calls[mockLog.mock.calls.length - 1][0];
      expect(lastLog).toContain('[ACTION] ready');
      expect(lastLog).toContain(largePayload.text); // Full text
      expect(lastLog).not.toContain('...');
      expect(lastLog).toContain('["item","item"'); // Raw array contents
    });

    it('should output high-density shorthand for UI_SYNC in STANDARD mode', () => {
      const client = MessageClient.getInstance();
      const syncPacket = {
        command: IncomingCommand.UI_SYNC,
        isPlaying: true,
        cacheCount: 42,
        cacheSizeBytes: 1024 * 1024 * 5,
        currentChapterIndex: 1,
        currentSentenceIndex: 5,
        logLevel: 1 // STANDARD
      };

      window.dispatchEvent(new MessageEvent('message', { data: syncPacket }));

      const lastLog = mockLog.mock.calls[mockLog.mock.calls.length - 1][0];
      expect(lastLog).toContain('[SIGNAL] UI_SYNC');
      expect(lastLog).toContain('State: PLAY | Progress: C1S5 | Cache: 42 (5.00MB)');
    });
  });
});
