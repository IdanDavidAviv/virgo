const { execSync } = require('child_process');

function test(mode) {
    console.log(`\n--- 🧪 TESTING MODE: ${mode} ---`);
    try {
        const output = execSync(`node .agent/skills/version_sentinel/scripts/git_history_audit.js --${mode}`, { encoding: 'utf8' });
        console.log(output);
    } catch (e) {
        console.error(`❌ FAILED: ${mode}\n`, e.stdout || e.message);
    }
}

console.log('🚀 Starting Audit Mode Verification...\n');

// 1. Test Patch (Anchor: currentVersion)
test('patch');

// 2. Test Minor (Anchor: currentMinor.0)
test('minor');

// 3. Test Major (Anchor: currentMajor.0.0)
test('major');

console.log('\n✅ Verification Script Complete.');
