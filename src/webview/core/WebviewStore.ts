import { MessageClient } from './messageClient';
import { IncomingCommand, UISyncPacket } from '@common/types';

export type Selector<T> = (state: UISyncPacket) => T;
export type Listener<T> = (value: T) => void;

/**
 * WebviewStore: A reactive View-Model that mirrors the Extension's StateStore.
 * Designed for high-performance UI updates via selector-based subscriptions.
 */
export class WebviewStore {
  private static instance: WebviewStore | null = null;
  private state: UISyncPacket | null = null;
  private listeners: Set<{ 
    selector: Selector<any>, 
    listener: Listener<any>, 
    lastValue: any 
  }> = new Set();

  private constructor() {
    const client = MessageClient.getInstance();
    client.onCommand<UISyncPacket>(IncomingCommand.UI_SYNC, (packet) => {
      this.updateState(packet);
    });
  }

  /**
   * Returns the singleton instance of WebviewStore.
   */
  public static getInstance(): WebviewStore {
    if (!WebviewStore.instance) {
      WebviewStore.instance = new WebviewStore();
    }
    return WebviewStore.instance;
  }

  /**
   * Resets the singleton instance (primarily for testing).
   */
  public static resetInstance(): void {
    WebviewStore.instance = null;
  }

  /**
   * Returns the current state.
   */
  public getState(): UISyncPacket | null {
    return this.state;
  }

  /**
   * Subscribes to a specific slice of the state.
   * The listener is only called if the selected value changes.
   * @param selector A function that extracts a value from the state.
   * @param listener A function called when the selected value changes.
   * @returns An unsubscribe function.
   */
  public subscribe<T>(selector: Selector<T>, listener: Listener<T>): () => void {
    const initialValue = this.state ? selector(this.state) : undefined;
    const entry = { selector, listener, lastValue: initialValue };
    this.listeners.add(entry);
    
    // Immediate notification of current value if state is already hydrated
    if (this.state !== null) {
      listener(initialValue as T);
    }

    return () => this.listeners.delete(entry);
  }

  /**
   * Internal method to update the state and notify relevant listeners.
   */
  private updateState(newState: UISyncPacket): void {
    const oldState = this.state;
    this.state = newState;

    this.listeners.forEach((entry) => {
      const newValue = entry.selector(newState);
      if (oldState === null || !this.isEqual(newValue, entry.lastValue)) {
        entry.lastValue = newValue;
        entry.listener(newValue);
      }
    });
  }

  /**
   * Simple equality check (shallow for objects/arrays, strict for primitives).
   */
  private isEqual(a: any, b: any): boolean {
    if (a === b) {return true;}
    if (typeof a !== typeof b) {return false;}
    
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {return false;}
      return a.every((val, index) => val === b[index]);
    }
    
    if (typeof a === 'object' && a !== null && b !== null) {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) {return false;}
      return keysA.every(key => a[key] === b[key]);
    }

    return false;
  }
}
