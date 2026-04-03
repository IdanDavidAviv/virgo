const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Git History Audit Tool
 * ---------------------
 * Performs high-integrity analysis of git history to identify the "Representative Story" of a release.
 */

function run(command) {
    try {
        return execSync(command, { encoding: 'utf8' }).trim();
    } catch (e) {
        return null;
    }
}

function getVersionAnchor() {
    // 1. Find the commit that set the CURRENT version in package.json
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const currentVersion = packageJson.version;
    
    // Find the hash of the commit that introduced this exact version line
    // We use -G to search for the string in the diff
    const anchorHash = run(`git log -G"\\\"version\\\": \\\"${currentVersion}\\\"" --pretty=format:%H -n 1 package.json`);
    
    if (!anchorHash) {
        // Fallback: Just use the last commit that touched package.json
        return run(`git log -n 1 --pretty=format:%H package.json`);
    }
    return anchorHash;
}

function audit() {
    const args = process.argv.slice(2);
    const showDiff = args.includes('--diff');
    const includeAgent = args.includes('--all');
    const fileFilter = args.find(a => a.startsWith('--file='))?.split('=')[1];
    
    const anchorArg = args.find(a => a.startsWith('--anchor='))?.split('=')[1];
    const targetArg = args.find(a => a.startsWith('--target='))?.split('=')[1] || 'HEAD';
    
    const anchor = anchorArg || getVersionAnchor();
    const target = targetArg;
    
    if (!anchor) {
        console.error('❌ Error: Could not identify version anchor (package.json history is missing).');
        process.exit(1);
    }

    console.log(`\n🔍 Version Anchor: [${anchor.substring(0, 7)}]`);
    console.log(`📁 Target: [${target === 'HEAD' ? 'HEAD' : target.substring(0, 7)}]`);
    console.log(`📁 Delta: [${anchor.substring(0, 7)}] -> [${target === 'HEAD' ? 'HEAD' : target.substring(0, 7)}]\n`);

    // 1. Log Delta (Filter out .agent changes unless --all)
    console.log('--- 📜 COMMIT LOG DELTA ---');
    let logCmd = `git log --oneline ${anchor}..${target}`;
    if (!includeAgent) {
        logCmd += ` -- . ":(exclude).agent"`;
    }
    const logs = run(logCmd);
    console.log(logs || '(No new user-facing commits since anchor)');

    // 2. Diff Stat (Impact Analysis - Filter out .agent changes unless --all)
    console.log('\n--- 📊 IMPACT ANALYSIS (STAT) ---');
    let statCmd = `git diff --stat ${anchor}..${target}`;
    if (!includeAgent) {
        statCmd += ` -- . ":(exclude).agent"`;
    }
    const stats = run(statCmd);
    console.log(stats || '(No user-facing code changes since anchor)');

    // 3. Diff Content (Deep Audit)
    if (showDiff) {
        console.log('\n--- 🕵️ DEEP AUDIT (DIFF CONTENT) ---');
        let diffCmd = `git diff -U1 ${anchor}..${target}`;
        if (fileFilter) {
            diffCmd += ` -- "${fileFilter}"`;
            console.log(`🎯 Filtering by file: ${fileFilter}`);
        } else if (!includeAgent) {
            diffCmd += ` -- . ":(exclude).agent"`;
        }
        const diffContent = run(diffCmd);
        console.log(diffContent || '(No user-facing diff content found)');
    }

    console.log('\n✅ Audit Complete.');
}

module.exports = { audit, getVersionAnchor };

if (require.main === module) {
    audit();
}
