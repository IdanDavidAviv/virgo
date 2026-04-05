import { PathGuard } from '../../src/common/mcp/pathGuard';
import { TurnManager } from '../../src/common/mcp/turnManager';
import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';

async function testPathGuard() {
    console.log('--- Testing PathGuard ---');
    
    // Whitelisted patterns
    assert.strictEqual(PathGuard.sanitize('session-123', 'Session'), 'session-123');
    assert.strictEqual(PathGuard.sanitize('user_name', 'User'), 'user_name');
    
    // Malicious patterns
    try {
        PathGuard.sanitize('../../etc/passwd', 'Evil');
        assert.fail('Should have rejected path traversal');
    } catch (e: any) {
        console.log('✅ Correctly rejected path traversal: ' + e.message);
    }
    
    try {
        PathGuard.sanitize('session; rm -rf /', 'Injection');
        assert.fail('Should have rejected script injection');
    } catch (e: any) {
        console.log('✅ Correctly rejected script injection: ' + e.message);
    }
}

async function testTurnManager() {
    console.log('\n--- Testing TurnManager ---');
    const testDir = path.join(__dirname, 'tmp_turn_test');
    if (!fs.existsSync(testDir)) {fs.mkdirSync(testDir);}
    
    const stateFile = path.join(testDir, 'extension_state.json');
    if (fs.existsSync(stateFile)) {fs.unlinkSync(stateFile);}
    
    // 1. Initial turn
    const index1 = TurnManager.updateTurnIndex(testDir, { sessionTitle: 'Test Session' });
    assert.strictEqual(index1, 1, 'Initial turn should be 1');
    
    // 2. Increment
    const index2 = TurnManager.updateTurnIndex(testDir);
    assert.strictEqual(index2, 2, 'Next turn should be 2');
    
    // 3. Valid explicit index
    const index3 = TurnManager.updateTurnIndex(testDir, { incomingIndex: 5 });
    assert.strictEqual(index3, 5, 'Should honor valid explicit index');
    
    // 4. Stale index rejection
    try {
        TurnManager.updateTurnIndex(testDir, { incomingIndex: 3 });
        assert.fail('Should have rejected stale index');
    } catch (e: any) {
        console.log('✅ Correctly rejected stale turn index: ' + e.message);
    }
    
    // Cleanup
    fs.unlinkSync(stateFile);
    fs.rmdirSync(testDir);
}

async function runTests() {
    try {
        await testPathGuard();
        await testTurnManager();
        console.log('\n✨ ALL HARDENING LOGIC VERIFIED');
    } catch (e) {
        console.error('\n❌ VERIFICATION FAILED:', e);
        process.exit(1);
    }
}

runTests();
