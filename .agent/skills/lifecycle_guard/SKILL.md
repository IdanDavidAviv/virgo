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

---

## 3. jsdom HTMLAudioElement Contract (Test Infrastructure)

> [!WARNING]
> **Scope**: Test environment only. This is NOT a production concern.

### 3.1 The Problem
`WebviewAudioEngine.playBlob()` sets `audio.src`, calls `audio.load()`, then awaits `canplay` → `play()` → `ended`. In **jsdom**, `HTMLAudioElement.load()` is a stub — it executes synchronously but dispatches **no media events**. This means `canplay` never fires and the inner Promise in `playBlob()` hangs indefinitely.

Symptom: Vitest reports `Error: Test timed out in 5000ms` for any test directly calling `playBlob()`.

### 3.2 The Fix
In `beforeEach` of any test suite that exercises `playBlob()`, mock `load()` to synchronously dispatch `canplay`:

```typescript
// For instance-specific audio elements (preferred when you have engine.audioElement):
const audio = engine.audioElement;
vi.spyOn(audio, 'load').mockImplementation(function(this: HTMLAudioElement) {
    this.dispatchEvent(new Event('canplay'));
});

// For all HTMLAudioElement instances (use when engine is reconstructed per-test):
vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function(this: HTMLAudioElement) {
    this.dispatchEvent(new Event('canplay'));
});
```

### 3.3 Verification
After applying the mock:
- The `ended` listener IS registered by `playBlob()` (verify via `addEventListener` spy).
- Manually call the `ended` listener to resolve the Promise.
- Assert `engine.isBusy()` returns `false` after `await playPromise`.

### 3.4 Affected Tests (resolved as of 2026-04-10)
- `tests/webview/core/RaceCondition.test.ts:47` — "SHOULD allow audio packets that match the current intent"
- `tests/webview/core/WebviewAudioEngine.test.ts:49` — "should acquire lock for playBlob and release it on completion"
