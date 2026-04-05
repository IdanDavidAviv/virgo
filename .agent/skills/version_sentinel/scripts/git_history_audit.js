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

/**
 * Calculates the version anchor based on the "height" of the current version and the scale of the upcoming release.
 * - Patch (--patch): Anchor is currentVersion (e.g., 2.0.8 -> summarizes work for 2.0.9).
 * - Minor (--minor): Anchor is Last Minor baseline (e.g., 2.0.8 -> 2.0.0; 2.1.5 -> 2.1.0).
 * - Major (--major): Anchor is Last Major baseline (e.g., 2.0.8 -> 2.0.0; 2.1.5 -> 2.0.0).
 */
function calculateAnchorVersion(currentVersion, type = 'patch') {
    const parts = currentVersion.split('.').map(Number);
    if (parts.length !== 3) return currentVersion;
    
    const [major, minor, patch] = parts;
    
    if (type === 'minor') {
        return `${major}.${minor}.0`; // Anchor to the start of the current minor series
    }
    
    if (type === 'major') {
        return `${major}.0.0`; // Anchor to the start of the current major series
    }
    
    // Default: Patch (summarize since current release)
    return currentVersion;
}

function getVersionAnchor(type = 'patch') {
    // 1. Find the commit that set the ANCHOR version in package.json
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const currentVersion = packageJson.version;
    const anchorVersion = calculateAnchorVersion(currentVersion, type);
    
    console.log(`🏷️  Current Version: ${currentVersion}`);
    console.log(`⚓ Target Anchor: ${anchorVersion} (${type.toUpperCase()} Release)`);
    
    // PRIORITY 1: Check if a git tag for horizontal parity exists (vX.Y.Z)
    const tagName = `v${anchorVersion}`;
    const tagHash = run(`git rev-parse ${tagName}`);
    if (tagHash) {
        console.log(`✅ Found Git Tag anchor: ${tagName} [${tagHash.substring(0, 7)}]`);
        return tagHash;
    }

    // PRIORITY 2: Fallback to string-searching with robust regex
    // We use a simpler pattern that is less likely to break on Windows/PowerShell
    console.log('🔍 Tag not found. Searching commit history for version string...');
    const anchorHash = run(`git log -G"version.: .${anchorVersion}" --pretty=format:%H -n 1 package.json`);
    
    if (!anchorHash) {
        console.warn(`⚠️  Warning: Could not find anchor commit for version ${anchorVersion}. Falling back to last package.json touch.`);
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
    --patch             Audit as a PATCH release (Anchor: current version).
    --minor             Audit as a MINOR release (Anchor: X.0.0 baseline).
    --major             Audit as a MAJOR release (Anchor: X.0.0 baseline).
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
    
    // Release Scale Flags
    let releaseType = 'patch';
    if (args.includes('--minor')) releaseType = 'minor';
    if (args.includes('--major')) releaseType = 'major';
    if (args.includes('--patch')) releaseType = 'patch'; // Re-affirm default if explicit

    if (args.includes('--all')) {
        console.warn('⚠️  Warning: The "--all" flag is deprecated. Use "--include-meta" for high-integrity agent alignment.');
        includeMeta = true;
    }

    const fileFilter = args.find(a => a.startsWith('--file='))?.split('=')[1];
    const anchorArg = args.find(a => a.startsWith('--anchor='))?.split('=')[1];
    const targetArg = args.find(a => a.startsWith('--target='))?.split('=')[1] || 'HEAD';
    
    const anchor = anchorArg || getVersionAnchor(releaseType);
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
        console.log('\n--- 🕵️ DEEP AUDIT (DIFF CONTENT - COMMITTED) ---');
        let diffCmd = `git diff -U1 ${anchor}..${target}`;
        if (fileFilter) {
            diffCmd += ` -- "${fileFilter}"`;
            console.log(`🎯 Filtering by file: ${fileFilter}`);
        } else if (!includeMeta) {
            diffCmd += ` -- . ":(exclude).agent"`;
        }
        const diffContent = run(diffCmd);
        console.log(diffContent || '(No user-facing diff content found)');

        // 3.1 Uncommitted Diff Content
        console.log('\n--- 🕵️ DEEP AUDIT (DIFF CONTENT - UNCOMMITTED) ---');
        let uncommittedDiffCmd = `git diff -U1 HEAD`;
        if (fileFilter) {
            uncommittedDiffCmd += ` -- "${fileFilter}"`;
        } else if (!includeMeta) {
            uncommittedDiffCmd += ` -- . ":(exclude).agent"`;
        }
        const uncommittedDiff = run(uncommittedDiffCmd);
        console.log(uncommittedDiff || '(No uncommitted diff content found)');
    }

    // 4. Staged Changes (Index)
    console.log('\n--- 📦 STAGED CHANGES (INDEX) ---');
    let stagedCmd = 'git diff --cached --stat';
    if (!includeMeta) {
        stagedCmd += ` -- . ":(exclude).agent"`;
    }
    const staged = run(stagedCmd);
    console.log(staged || '(No staged changes)');

    // 5. Unstaged Changes (Working Directory)
    console.log('\n--- ⚒️ UNSTAGED WORKING DELTA ---');
    let unstagedCmd = 'git diff --stat';
    if (!includeMeta) {
        unstagedCmd += ` -- . ":(exclude).agent"`;
    }
    const unstaged = run(unstagedCmd);
    console.log(unstaged || '(No unstaged changes)');

    console.log('\n✅ Audit Complete.');
}

module.exports = { audit, getVersionAnchor };

if (require.main === module) {
    audit();
}
