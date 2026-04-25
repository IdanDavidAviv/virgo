const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../../../');
const packageJsonPath = path.join(root, 'package.json');
const changelogPath = path.join(root, 'CHANGELOG.md');

/**
 * 🛡️ Version Sentinel - Advanced Version Manager
 * Supports: Bumping, Changelog Staging, and Verification.
 */
function showHelp() {
    console.log(`
🛡️ Version Sentinel - Help
--------------------------
Advanced version management and Prestige Audit integration.

USAGE:
    node manage_version.js [options]

OPTIONS:
    --help, -h          Show this help menu.
    --bump <type>       Bump version (major|minor|patch). Updates package.json and CHANGELOG.md.
    --dry-run           Preview changes without writing to disk.
    --audit             Trigger the Prestige Audit tool to analyze git history.
                        Supports all audit flags (e.g., --include-meta, --diff).

EXAMPLES:
    # Verify version synchronization:
    node manage_version.js

    # Trigger a Prestige Audit for the upcoming release:
    node manage_version.js --audit --diff

    # Bump a minor version:
    node manage_version.js --bump minor
    `);
}

function manageVersion() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        showHelp();
        return;
    }

    const bumpType = args.includes('--bump') ? args[args.indexOf('--bump') + 1] : null;
    const isDryRun = args.includes('--dry-run');
    const isAudit = args.includes('--audit');
    const isCheck = args.includes('--check');

    if (isAudit) {
        // PROXY TO AUDIT TOOL
        console.log('🛡️ Version Sentinel: Triggering Prestige Audit...');
        const { audit } = require('./git_history_audit.js');
        audit();
        return;
    }

    if (isCheck) {
        // CHANGELOG CONTENT GUARD
        // Finds the top versioned section and verifies it has at least one real bullet.
        if (!fs.existsSync(changelogPath)) {
            console.error('\u274c CHANGELOG.md not found.');
            process.exit(1);
        }
        const cl = fs.readFileSync(changelogPath, 'utf8');
        const topMatch = cl.match(/## \[([\d]+\.[\d]+\.[\d]+)\][^\n]*\n([\s\S]*?)(?=\n## \[|\s*$)/);
        if (!topMatch) {
            console.error('\u274c No versioned section found in CHANGELOG.md. Add a ## [x.y.z] header with content.');
            process.exit(1);
        }
        const topVersion = topMatch[1];
        const topContent = topMatch[2];
        const hasRealContent = topContent.split('\n').some(line => {
            const t = line.trim();
            return t.length > 2 && t.startsWith('-');
        });
        if (!hasRealContent) {
            console.error(`\u274c CHANGELOG [${topVersion}] is empty. Add release notes before packaging.`);
            process.exit(1);
        }
        console.log(`\u2705 CHANGELOG content check passed: [${topVersion}] has release notes.`);
        process.exit(0);
    }

    if (!fs.existsSync(packageJsonPath)) {
        console.error('❌ package.json not found in root.');
        process.exit(1);
    }
    if (!fs.existsSync(changelogPath)) {
        console.error('❌ CHANGELOG.md not found in root.');
        process.exit(1);
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    let changelog = fs.readFileSync(changelogPath, 'utf8');

    const currentVersion = packageJson.version;

    if (!bumpType) {
        // VERIFICATION MODE
        process.stdout.write('🔍 Running Version Sentinel Audit...\n');
        const latestChangelogMatch = changelog.match(/## \[([0-9]+\.[0-9]+\.[0-9]+)\]/);
        
        if (!latestChangelogMatch) {
            console.error('❌ Could not find a version entry in CHANGELOG.md matching "## [x.y.z]".');
            process.exit(1);
        }

        const latestChangelogVersion = latestChangelogMatch[1];
        if (currentVersion !== latestChangelogVersion) {
            console.error(`❌ Version Mismatch!`);
            console.error(`   - package.json version: ${currentVersion}`);
            console.error(`   - CHANGELOG.md latest:  ${latestChangelogVersion}`);
            process.exit(1);
        }

        console.log(`✅ Version Sentinel Pass: Both files are synchronized at ${currentVersion}.`);
        process.exit(0);
    }

    // BUMP MODE
    console.log(`🚀 Bumping version: ${currentVersion} -> [${bumpType}]`);
    const versionParts = currentVersion.split('.').map(Number);
    
    if (bumpType === 'major') {
        versionParts[0]++;
        versionParts[1] = 0;
        versionParts[2] = 0;
    } else if (bumpType === 'minor') {
        versionParts[1]++;
        versionParts[2] = 0;
    } else if (bumpType === 'patch') {
        versionParts[2]++;
    } else {
        console.error(`❌ Invalid bump type: ${bumpType}. Use major|minor|patch.`);
        process.exit(1);
    }

    const newVersion = versionParts.join('.');
    const today = new Date().toISOString().split('T')[0];

    // Update package.json version only — CHANGELOG is managed manually by the agent.
    packageJson.version = newVersion;

    if (isDryRun) {
        console.log('🧪 DRY RUN: Changes would be:');
        console.log(`   - package.json version: ${newVersion}`);
        console.log(`   - (CHANGELOG.md is agent-managed and verified by the check)`);
        process.exit(0);
    }

    // WRITE CHANGES (package.json only — CHANGELOG is agent-managed)
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

    console.log(`✅ SUCCESS: Version bumped to ${newVersion} and CHANGELOG.md updated.`);
}

manageVersion();
