const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../../../');
const packageJsonPath = path.join(root, 'package.json');
const changelogPath = path.join(root, 'CHANGELOG.md');

/**
 * 🛡️ Version Sentinel - Consistency Check Script
 */
function verify() {
    process.stdout.write('🔍 Running Version Sentinel Audit...\n');

    if (!fs.existsSync(packageJsonPath)) {
        console.error('❌ package.json not found in root.');
        process.exit(1);
    }
    if (!fs.existsSync(changelogPath)) {
        console.error('❌ CHANGELOG.md not found in root.');
        process.exit(1);
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const changelog = fs.readFileSync(changelogPath, 'utf8');

    const packageVersion = packageJson.version;
    const latestChangelogMatch = changelog.match(/## \[([0-9]+\.[0-9]+\.[0-9]+)\]/);

    if (!latestChangelogMatch) {
        console.error('❌ Could not find a version entry in CHANGELOG.md matching "## [x.y.z]".');
        process.exit(1);
    }

    const latestChangelogVersion = latestChangelogMatch[1];

    if (packageVersion !== latestChangelogVersion) {
        console.error(`❌ Version Mismatch!`);
        console.error(`   - package.json version: ${packageVersion}`);
        console.error(`   - CHANGELOG.md latest:  ${latestChangelogVersion}`);
        process.exit(1);
    }

    console.log(`✅ Version Sentinel Pass: Both files are synchronized at ${packageVersion}.`);
    process.exit(0);
}

verify();
