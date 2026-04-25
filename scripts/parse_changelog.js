#!/usr/bin/env node
/**
 * parse_changelog.js <version>
 * Extracts the release notes for a specific version from CHANGELOG.md.
 * Outputs clean markdown to stdout — used by GitHub Actions and publish_github.js.
 */
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
  console.error('Usage: parse_changelog.js <version>  (e.g. 2.7.2)');
  process.exit(1);
}

const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
if (!fs.existsSync(changelogPath)) {
  console.error(`❌ CHANGELOG.md not found at ${changelogPath}`);
  process.exit(1);
}

const lines = fs.readFileSync(changelogPath, 'utf8').split('\n');

let inSection = false;
const output = [];

for (const line of lines) {
  // Detect a version header like "## [2.7.2] - 2026-04-25"
  if (/^## \[/.test(line)) {
    if (inSection) break; // Hit the next version section — stop
    if (line.includes(`[${version}]`)) {
      inSection = true;
      continue; // Skip the header line itself
    }
  }
  if (inSection) output.push(line);
}

if (output.length === 0) {
  console.error(`❌ No CHANGELOG entry found for version ${version}`);
  console.error(`   Make sure CHANGELOG.md contains a "## [${version}]" section.`);
  process.exit(1);
}

// Trim leading/trailing blank lines
const trimmed = output.join('\n').replace(/^\s+|\s+$/g, '');
process.stdout.write(trimmed + '\n');
