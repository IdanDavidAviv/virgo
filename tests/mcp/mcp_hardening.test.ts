import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PathGuard } from '../../src/common/mcp/pathGuard';
import { TurnManager } from '../../src/common/mcp/turnManager';
import * as fs from 'fs';
import * as path from 'path';

describe('MCP Hardening Verification', () => {
    
    it('PathGuard SHOULD sanitize whitelisted strings and reject malicious patterns', () => {
        // Whitelisted patterns
        expect(PathGuard.sanitize('session-123', 'Session')).toBe('session-123');
        expect(PathGuard.sanitize('user_name', 'User')).toBe('user_name');
        
        // Malicious patterns
        expect(() => PathGuard.sanitize('../../etc/passwd', 'Evil')).toThrow(/Only alphanumeric/);
        expect(() => PathGuard.sanitize('session; rm -rf /', 'Injection')).toThrow(/Only alphanumeric/);
    });

    describe('TurnManager Strategy', () => {
        const testDir = path.join(__dirname, 'tmp_turn_test');
        const stateFile = path.join(testDir, 'extension_state.json');

        beforeEach(() => {
            if (!fs.existsSync(testDir)) {
                fs.mkdirSync(testDir);
            }
            if (fs.existsSync(stateFile)) {
                fs.unlinkSync(stateFile);
            }
        });

        afterEach(() => {
            if (fs.existsSync(stateFile)) {
                fs.unlinkSync(stateFile);
            }
            if (fs.existsSync(testDir)) {
                fs.rmdirSync(testDir);
            }
        });

        it('SHOULD atomicaly increment turn index and reject stale inputs', () => {
            // 1. Initial turn
            const index1 = TurnManager.updateTurnIndex(testDir, { sessionTitle: 'Test Session' });
            expect(index1).toBe(1);
            
            // 2. Increment
            const index2 = TurnManager.updateTurnIndex(testDir);
            expect(index2).toBe(2);
            
            // 3. Valid explicit index
            const index3 = TurnManager.updateTurnIndex(testDir, { incomingIndex: 5 });
            expect(index3).toBe(5);
            
            // 4. Stale index rejection
            expect(() => TurnManager.updateTurnIndex(testDir, { incomingIndex: 3 })).toThrow(/Stale turn index/);
        });
    });
});
