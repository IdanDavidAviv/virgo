import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { TurnManager } from '../../src/common/mcp/turnManager';

// [INTEGRITY] Mock fs and path for mcpStandalone logic testing
const TEST_ROOT = path.join(os.tmpdir(), 'virgo_test_' + Math.random().toString(36).substring(7));

describe('TurnSentinel Sovereignty (TDD: #43)', () => {
    
    beforeEach(() => {
        if (!fs.existsSync(TEST_ROOT)) {
            fs.mkdirSync(TEST_ROOT, { recursive: true });
        }
    });

    afterEach(() => {
        if (fs.existsSync(TEST_ROOT)) {
            fs.rmSync(TEST_ROOT, { recursive: true, force: true });
        }
        vi.clearAllMocks();
    });

    it('SHOULD warn on stale turn index and auto-increment (no throw — Drift Guard relaxed)', async () => {
        const sessionPath = path.join(TEST_ROOT, 'session123');
        fs.mkdirSync(sessionPath, { recursive: true });
        
        // 1. Simulate existing state at turn 10
        fs.writeFileSync(path.join(sessionPath, 'extension_state.json'), JSON.stringify({ current_turn_index: 10 }));

        // 2. Stale index — TurnSentinel now WARNS and auto-increments (non-blocking)
        // It does NOT throw; instead it returns the next sequential index past current.
        const staleResult = TurnManager.updateTurnIndex(sessionPath, { incomingIndex: 5 });
        expect(staleResult).toBeGreaterThan(10); // auto-incremented past current turn 10
        
        // 3. Accept valid future index
        const index = TurnManager.updateTurnIndex(sessionPath, { incomingIndex: staleResult + 5 });
        expect(index).toBe(staleResult + 5);
        
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'extension_state.json'), 'utf-8'));
        expect(state.current_turn_index).toBe(staleResult + 5);
    });

    it('SHOULD increment turn index automatically if not provided', async () => {
        const sessionPath = path.join(TEST_ROOT, 'session456');
        fs.mkdirSync(sessionPath, { recursive: true });
        
        // 1. Initial State
        fs.writeFileSync(path.join(sessionPath, 'extension_state.json'), JSON.stringify({ current_turn_index: 5 }));

        // 2. Auto-increment
        const nextIndex = TurnManager.updateTurnIndex(sessionPath);
        expect(nextIndex).toBe(6);
        
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'extension_state.json'), 'utf-8'));
        expect(state.current_turn_index).toBe(6);
    });
});
