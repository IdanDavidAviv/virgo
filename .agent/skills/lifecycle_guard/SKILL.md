---
name: lifecycle_guard
description: Protocols for preventing memory leaks and event listener accumulation in VS Code webview extensions.
---

# Lifecycle Guard Protocol

## 0. Rationale
Webview components in VS Code often rely on global event listeners (`window.addEventListener`) and reactive stores. In a test environment like `vitest` (jsdom), these listeners persist across test suites unless explicitly removed, causing memory leaks, process hangs, and erratic test failures.

## 1. Implementation Patterns

### 1.1 Explicit Disposal
Every singleton or component that registers global listeners MUST implement a `dispose()` or `cleanup()` method.

```typescript
export class MessageClient {
  private handlers = new Map<string, Function>();

  constructor() {
    this.onMessage = this.onMessage.bind(this);
    window.addEventListener('message', this.onMessage);
  }

  public dispose() {
    window.removeEventListener('message', this.onMessage);
    this.handlers.clear();
  }
}
```

### 1.2 Global Test Setup
Use a `vitest.setup.ts` file to mock missing browser APIs (e.g., `indexedDB`, `scrollIntoView`) and ensure environmental consistency.

```typescript
import { vi } from 'vitest';

// Global mocks
if (typeof window !== 'undefined') {
  window.scrollIntoView = vi.fn();
}

// Global cleanup hooks
afterEach(() => {
  WebviewStore.getInstance().dispose();
  MessageClient.getInstance().dispose();
});
```

## 2. Verification Protocol
1. **Heuristic**: If Vitest finishes with "Exit Code 1" despite all tests passing, a leak is present.
2. **Action**: Search for `setTimeout`, `setInterval`, or `addEventListener` calls that lack a corresponding `remove` or `clear` call.
