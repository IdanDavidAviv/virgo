const fs = require('fs');
const path = require('path');

/**
 * Release Prestige - Artifact Verification Utility
 * This script ensures the generated .vsix exists and is non-zero.
 */
function verifyArtifact() {
    const rootDir = path.join(__dirname, '..', '..', '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const vsixName = `${pkg.name}-${pkg.version}.vsix`;
    const vsixPath = path.join(rootDir, vsixName);

    console.log(`🔍 Auditing release artifact: ${vsixName}`);

    if (!fs.existsSync(vsixPath)) {
        console.error(`❌ FAILED: Artifact NOT found at ${vsixPath}`);
        process.exit(1);
    }

    const stats = fs.statSync(vsixPath);
    const sizeInKB = Math.round(stats.size / 1024);

    if (stats.size === 0) {
        console.error(`❌ FAILED: Artifact is empty (0 bytes). Build corrupted.`);
        process.exit(1);
    }

    console.log(`✅ SUCCESS: Artifact found (${sizeInKB} KB).`);
    console.log(`🎯 Next Step: Install ${vsixName} locally to smoke test.`);
}

verifyArtifact();
