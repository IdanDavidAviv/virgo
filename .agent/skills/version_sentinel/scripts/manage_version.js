const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../../../');
const packageJsonPath = path.join(root, 'package.json');
const changelogPath = path.join(root, 'CHANGELOG.md');

/**
 * 🛡️ Version Sentinel - Advanced Version Manager
 * Supports: Bumping, Changelog Staging, and Verification.
 */
function manageVersion() {
    const args = process.argv.slice(2);
    const bumpType = args.includes('--bump') ? args[args.indexOf('--bump') + 1] : null;
    const isDryRun = args.includes('--dry-run');
    const isAudit = args.includes('--audit');

    if (isAudit) {
        // PROXY TO AUDIT TOOL
        console.log('🛡️ Version Sentinel: Triggering Prestige Audit...');
        const { audit } = require('./git_history_audit.js');
        audit();
        return;
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

    // 1. Update Changelog (Handle [Unreleased])
    const unreleasedHeader = '## [Unreleased]';
    if (!changelog.includes(unreleasedHeader)) {
        console.error(`❌ FAILED: CHANGELOG.md must contain a "${unreleasedHeader}" section.`);
        process.exit(1);
    }

    const newHeader = `## [${newVersion}] - ${today}`;
    changelog = changelog.replace(unreleasedHeader, newHeader);

    // 2. Add new empty [Unreleased] section for future
    const insertionPoint = changelog.indexOf(newHeader);
    const unreleasedTemplate = `## [Unreleased]\n\n### Added\n- \n\n`;
    changelog = changelog.slice(0, insertionPoint) + unreleasedTemplate + changelog.slice(insertionPoint);

    // 3. Prepare Package.json
    packageJson.version = newVersion;

    if (isDryRun) {
        console.log('🧪 DRY RUN: Changes would be:');
        console.log(`   - package.json version: ${newVersion}`);
        console.log(`   - CHANGELOG.md header:  ${newHeader}`);
        process.exit(0);
    }

    // WRITE CHANGES
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
    fs.writeFileSync(changelogPath, changelog);

    console.log(`✅ SUCCESS: Version bumped to ${newVersion} and CHANGELOG.md updated.`);
}

manageVersion();
