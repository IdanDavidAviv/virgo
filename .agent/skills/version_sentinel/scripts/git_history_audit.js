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

function showHelp() {
    console.log(`
🛡️ Git History Audit Tool - Help
-------------------------------
Performs high-integrity analysis of git history to identify the "Representative Story" of a release.

USAGE:
    node git_history_audit.js [options]

OPTIONS:
    --help, -h          Show this help menu.
    --include-meta      Include .agent/ infrastructure changes in the audit (Filtered by default).
    --diff              Show full diff content for a deep audit of code logic.
    --anchor=<hash>     Override the starting version anchor (default: auto-detected from package.json).
    --target=<hash>     Set the target commit for analysis (default: HEAD).
    --file=<path>       Filter the deep audit (diff) to a specific file or directory.
    --all               [DEPRECATED] Alias for --include-meta.

EXAMPLES:
    # Standard user-facing audit:
    node git_history_audit.js

    # Deep logic audit with full diffs:
    node git_history_audit.js --diff

    # Full repository audit including agent infrastructure:
    node git_history_audit.js --include-meta

    # Custom range audit:
    node git_history_audit.js --anchor=v1.5.0 --target=v1.6.0
    `);
}

function audit() {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h')) {
        showHelp();
        return;
    }

    const showDiff = args.includes('--diff');
    let includeMeta = args.includes('--include-meta');
    
    if (args.includes('--all')) {
        console.warn('⚠️  Warning: The "--all" flag is deprecated. Use "--include-meta" for high-integrity agent alignment.');
        includeMeta = true;
    }

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

    // 1. Log Delta (Filter out .agent changes unless --include-meta)
    console.log('--- 📜 COMMIT LOG DELTA ---');
    let logCmd = `git log --oneline ${anchor}..${target}`;
    if (!includeMeta) {
        logCmd += ` -- . ":(exclude).agent"`;
    }
    const logs = run(logCmd);
    console.log(logs || '(No new user-facing commits since anchor)');

    // 2. Diff Stat (Impact Analysis - Filter out .agent changes unless --include-meta)
    console.log('\n--- 📊 IMPACT ANALYSIS (STAT) ---');
    let statCmd = `git diff --stat ${anchor}..${target}`;
    if (!includeMeta) {
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
        } else if (!includeMeta) {
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
