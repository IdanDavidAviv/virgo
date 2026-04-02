import { vi } from 'vitest';

// Mock indexedDB globally for JSDOM environment
if (typeof window !== 'undefined') {
    (global as any).indexedDB = {
        open: vi.fn().mockReturnValue({
            onupgradeneeded: null,
            onsuccess: null,
            onerror: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn()
        }),
        deleteDatabase: vi.fn(),
        cmp: vi.fn(),
        databases: vi.fn()
    };
    
    // Also mock IDBKeyRange if needed
    (global as any).IDBKeyRange = {};
}
