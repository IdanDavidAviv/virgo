import { IncomingCommand, OutgoingAction } from '@common/types';

/**
 * MessageClient singleton for webview-to-extension communication.
 * Encapsulates the VS Code Webview API and provides type-safe IPC.
 */
export class MessageClient {
  private static instance: MessageClient | null = null;
  private vscode: any;
  private handlers: Map<string, Array<(payload: any) => void>> = new Map();

  private constructor() {
    // VS Code API acquireVsCodeApi can only be called ONCE per session.
    // We check window.vscode first to prevent fatal errors and support legacy scripts.
    if ((window as any).vscode) {
      this.vscode = (window as any).vscode;
    } else if ((window as any).acquireVsCodeApi) {
      this.vscode = (window as any).acquireVsCodeApi();
      (window as any).vscode = this.vscode;
    } else {
      console.warn('[MessageClient] acquireVsCodeApi is not available. Are you in a VS Code webview?');
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('message', (event) => this.handleMessage(event));
    }
  }

  /**
   * Returns the singleton instance of MessageClient.
   */
  public static getInstance(): MessageClient {
    if (!MessageClient.instance) {
      MessageClient.instance = new MessageClient();
    }
    return MessageClient.instance;
  }

  /**
   * Resets the singleton instance (primarily for testing).
   */
  public static resetInstance(): void {
    MessageClient.instance = null;
  }

  /**
   * Sends an action to the extension.
   * @param action The OutgoingAction to send.
   * @param payload The payload data associated with the action.
   */
  public postAction<T = any>(action: OutgoingAction, payload?: T): void {
    if (!this.vscode) {
      console.warn(`[MessageClient] Cannot post action ${action}: VS Code API not available.`);
      return;
    }
    this.vscode.postMessage({
      command: action,
      payload,
    });
  }

  /**
   * Registers a listener for an incoming command from the extension.
   * @param command The IncomingCommand to listen for.
   * @param callback The function to call when the command is received.
   */
  public onCommand<T = any>(command: IncomingCommand, callback: (payload: T) => void): void {
    const cmdStr = command as string;
    if (!this.handlers.has(cmdStr)) {
      this.handlers.set(cmdStr, []);
    }
    this.handlers.get(cmdStr)?.push(callback);
  }

  /**
   * Internal message handler that routes incoming window messages to registered callbacks.
   */
  private handleMessage(event: MessageEvent): void {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }

    const { command, payload, ...rest } = message;
    if (!command) {
      return;
    }

    // Support both legacy spread structure and new nested payload structure
    const finalPayload = payload !== undefined ? payload : rest;

    const commandHandlers = this.handlers.get(command);
    if (commandHandlers) {
      commandHandlers.forEach((handler) => handler(finalPayload));
    }
  }
}
