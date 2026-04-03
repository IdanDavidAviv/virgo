import { WebviewStore, Selector, Listener } from './WebviewStore';
import { MessageClient } from './MessageClient';
import { OutgoingAction } from '../../common/types';

/**
 * BaseComponent: Abstract foundation for all UI components in the Read Aloud Dashboard.
 * Handles DOM element mapping, store subscriptions, and lifecycle hooks.
 */
export abstract class BaseComponent<T extends Record<string, HTMLElement | null | (HTMLElement | null)[] | undefined>> {
  protected els: T;
  protected store: WebviewStore;
  private unsubscribers: Array<() => void> = [];

  constructor(elements: T) {
    this.els = elements;
    this.store = WebviewStore.getInstance();
    this.validateElements();
  }

  /**
   * Validates that all critical DOM elements are present.
   */
  protected validateElements(): void {
    Object.entries(this.els).forEach(([name, el]) => {
      if (Array.isArray(el)) {
        el.forEach((subEl, i) => {
          if (!subEl) {
            console.warn(`[Component] Missing expected sub-element for ${this.constructor.name}: ${name}[${i}]`);
          }
        });
      } else if (!el) {
        console.warn(`[Component] Missing expected element for ${this.constructor.name}: ${name}`);
      }
    });
  }

  /**
   * Post an action to the extension with Tier-3 shorthand logging.
   */
  protected postAction(command: OutgoingAction, payload?: any): void {
    console.log(`[ACTION] ${command} | ${JSON.stringify(payload || '')}`);
    MessageClient.getInstance().postAction(command, payload);
  }

  /**
   * Subscribes to a store slice and tracks the unsubscriber for cleanup.
   */
  protected subscribe<V>(selector: Selector<V>, listener: Listener<V>): void {
    const unsub = this.store.subscribe(selector, listener);
    this.unsubscribers.push(unsub);
  }

  /**
   * Subscribes to a local UI store slice and tracks the unsubscriber for cleanup.
   */
  protected subscribeUI<V>(selector: Selector<V, any>, listener: Listener<V>): void {
    const unsub = this.store.subscribeUI(selector, listener);
    this.unsubscribers.push(unsub);
  }

  /**
   * Finalizes the component instance. Called by the subclass or entry point.
   */
  public mount(): void {
    const start = performance.now();
    try {
      this.render();
      const duration = (performance.now() - start).toFixed(2);
      console.log(`[MOUNT] ${this.constructor.name} | Initial Render: ${duration}ms`);
    } catch (err) {
      console.error(`[FATAL] ${this.constructor.name} | Mount Failed:`, err);
    }
  }

  /**
   * Cleans up all store subscriptions.
   */
  public unmount(): void {
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers = [];
  }

  /**
   * Abstract render method to be implemented by child components.
   */
  public abstract render(): void;

  /**
   * Protected helper for sanitized, tagged logging.
   */
  protected log(msg: string, type: 'info' | 'warn' | 'error' = 'info'): void {
    const formatted = `[${this.constructor.name}] ${msg}`;
    if (type === 'error') {
      console.error(formatted);
    } else if (type === 'warn') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }
}
