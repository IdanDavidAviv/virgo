const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Package Extension Utility
 * Usage: node scripts/package.js [--dry-run]
 */
function packageExtension() {
  const isDryRun = process.argv.includes('--dry-run');
  const rootDir = path.join(__dirname, '..');
  
  // Load version from package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const currentVersion = pkg.version;
  const newVsixName = `${pkg.name}-${currentVersion}.vsix`;

  if (isDryRun) {
    console.log('🧪 DRY RUN: Simulating packaging and cleanup...');
  }

  // 1. High-Integrity Packaging (Success Gate)
  console.log('🚀 Step 1: Generating VSIX package via vsce...');
  try {
    if (isDryRun) {
      console.log('🧪 DRY RUN: npx @vscode/vsce package');
    } else {
      execSync('npx @vscode/vsce package', { 
        cwd: rootDir, 
        stdio: 'inherit' 
      });
      console.log(`✅ Step 1: Successfully generated ${newVsixName}`);
    }
  } catch (error) {
    console.error('❌ Step 1 FAILED: Packaging aborted. Integrity preserved.');
    process.exit(1);
  }

  // 2. Success-Gated Cleanup
  console.log('🧹 Step 2: Auditing legacy artifacts for cleanup...');
  const files = fs.readdirSync(rootDir);
  const vsixFiles = files.filter(f => f.endsWith('.vsix'));

  // Filter out the newly created package (or the one that SHOULD exist)
  const legacyVsix = vsixFiles.filter(f => f !== newVsixName);

  if (legacyVsix.length > 0) {
    legacyVsix.forEach(file => {
      const filePath = path.join(rootDir, file);
      if (isDryRun) {
        console.log(`🧪 DRY RUN: Would delete legacy artifact: ${file}`);
      } else {
        console.log(`🗑️ Deleting legacy artifact: ${file}`);
        fs.unlinkSync(filePath);
      }
    });
    console.log(`✅ Step 2: Cleaned up ${legacyVsix.length} legacy artifacts.`);
  } else {
    console.log('✨ Step 2: No legacy artifacts found.');
  }

  if (isDryRun) {
    console.log('🏁 DRY RUN COMPLETE: 0 physical changes made.');
  } else {
    console.log(`🎯 SUCCESS: Extension version ${currentVersion} is ready for release!`);
  }
}

packageExtension();
