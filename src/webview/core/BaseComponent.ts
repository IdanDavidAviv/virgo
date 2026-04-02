import { WebviewStore, Selector, Listener } from './WebviewStore';

/**
 * BaseComponent: Abstract foundation for all UI components in the Read Aloud Dashboard.
 * Handles DOM element mapping, store subscriptions, and lifecycle hooks.
 */
export abstract class BaseComponent<T extends Record<string, HTMLElement | null>> {
  protected els: T;
  protected store: WebviewStore;
  private unsubscribers: Array<() => void> = [];

  constructor(elements: T) {
    this.els = elements;
    this.store = WebviewStore.getInstance();
    this.validateElements();
  }

  /**
   * Validates that all required elements are present in the DOM.
   */
  protected validateElements(): void {
    Object.entries(this.els).forEach(([name, el]) => {
      if (!el) {
        console.warn(`[Component] Missing expected element for ${this.constructor.name}: ${name}`);
      }
    });
  }

  /**
   * Subscribes to a store slice and tracks the unsubscriber for cleanup.
   */
  protected subscribe<V>(selector: Selector<V>, listener: Listener<V>): void {
    const unsub = this.store.subscribe(selector, listener);
    this.unsubscribers.push(unsub);
  }

  /**
   * Finalizes the component instance. Called by the subclass or entry point.
   */
  public mount(): void {
    this.render();
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
}
