import { WebviewStore, Selector, Listener } from './WebviewStore';
import { MessageClient } from './MessageClient';
import { LogLevel, OutgoingAction } from '../../common/types';

/**
 * BaseComponent: Abstract foundation for all UI components in the Read Aloud Dashboard.
 * Handles DOM element mapping, store subscriptions, and lifecycle hooks.
 */
export abstract class BaseComponent<T extends Record<string, HTMLElement | null | (HTMLElement | null)[] | undefined>> {
  protected els: T;
  protected store: WebviewStore;
  private unsubscribers: Array<() => void> = [];
  private domListeners: Array<{
    target: EventTarget;
    type: string;
    listener: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
  }> = [];

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
   * Safe Event Registration: Tracks listeners for automatic cleanup.
   */
  protected registerEventListener(
    target: EventTarget | null,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (!target) {return;}
    target.addEventListener(type, listener, options);
    this.domListeners.push({ target, type, listener, options });
  }

  /**
   * Finalizes the component instance. Called by the subclass or entry point.
   */
  public mount(): void {
    const start = performance.now();
    try {
      this.render();
      this.onMount?.();
      const duration = (performance.now() - start).toFixed(2);
      const logLevel = this.store.getState()?.logLevel || LogLevel.STANDARD;
      if (logLevel === LogLevel.VERBOSE) {
        console.log(`[MOUNT] ${this.constructor.name} | Initial Render: ${duration}ms`);
      }
    } catch (err) {
      console.error(`[FATAL] ${this.constructor.name} | Mount Failed:`, err);
    }
  }

  /**
   * Cleans up all store subscriptions and DOM listeners.
   */
  public unmount(): void {
    this.onUnmount?.();
    
    // Clear Store Subscriptions
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers = [];

    // Clear DOM Listeners
    this.domListeners.forEach(({ target, type, listener, options }) => {
      target.removeEventListener(type, listener, options);
    });
    this.domListeners = [];
  }

  /**
   * Optional lifecycle hooks for subclasses.
   */
  protected onMount?(): void;
  protected onUnmount?(): void;

  /**
   * Abstract render method to be implemented by child components.
   */
  public abstract render(): void;

  /**
   * Triggers a standard pulse animation on the specified element(s).
   */
  protected pulse(el: HTMLElement | null | (HTMLElement | null)[]): void {
    const list = Array.isArray(el) ? el : [el];
    list.forEach(target => {
      if (target) {
        target.classList.add('pulse');
        setTimeout(() => target.classList.remove('pulse'), 400);
      }
    });
  }

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
      // Info logs are only visible in VERBOSE mode
      const logLevel = this.store.getState()?.logLevel || LogLevel.STANDARD;
      if (logLevel === LogLevel.VERBOSE) {
        console.log(formatted);
      }
    }
  }
}
