import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { getAndUpdateTurnIndex } from '../../src/extension/mcp/mcpStandalone';

// [INTEGRITY] Mock fs and path for mcpStandalone logic testing
const TEST_ROOT = path.join(os.tmpdir(), 'read_aloud_test_' + Math.random().toString(36).substring(7));

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

    it('SHOULD reject an injection with a stale turn index (Drift Guard)', async () => {
        const sessionPath = path.join(TEST_ROOT, 'session123');
        fs.mkdirSync(sessionPath, { recursive: true });
        
        // 1. Simulate existing state at turn 10
        fs.writeFileSync(path.join(sessionPath, 'extension_state.json'), JSON.stringify({ current_turn_index: 10 }));

        // 2. Reject stale index
        expect(() => getAndUpdateTurnIndex(sessionPath, undefined, 5)).toThrow(/Stale turn index/);
        
        // 3. Accept valid future index
        const index = getAndUpdateTurnIndex(sessionPath, undefined, 11);
        expect(index).toBe(11);
        
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'extension_state.json'), 'utf-8'));
        expect(state.current_turn_index).toBe(11);
    });

    it('SHOULD increment turn index automatically if not provided', async () => {
        const sessionPath = path.join(TEST_ROOT, 'session456');
        fs.mkdirSync(sessionPath, { recursive: true });
        
        // 1. Initial State
        fs.writeFileSync(path.join(sessionPath, 'extension_state.json'), JSON.stringify({ current_turn_index: 5 }));

        // 2. Auto-increment
        const nextIndex = getAndUpdateTurnIndex(sessionPath);
        expect(nextIndex).toBe(6);
        
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'extension_state.json'), 'utf-8'));
        expect(state.current_turn_index).toBe(6);
    });
});
