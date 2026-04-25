#!/usr/bin/env node
/**
 * publish_github.js
 * Local fallback for creating a GitHub Release with VSIX attached.
 * Used when CI is unavailable or for hotfix releases.
 *
 * Usage:
 *   $env:GITHUB_TOKEN = "ghp_..."; node scripts/publish_github.js
 *   npm run release:github
 *
 * Reads version from package.json, parses CHANGELOG.md automatically.
 * The VSIX must already exist (run npm run release:package first).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pkg = require('../package.json');
const VERSION = pkg.version;
const OWNER = 'IdanDavidAviv';
const REPO = 'virgo';
const TAG = `v${VERSION}`;
const VSIX_PATH = path.join(__dirname, '..', `virgo-${VERSION}.vsix`);

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('❌ Set GITHUB_TOKEN env var before running this script.');
  console.error('   $env:GITHUB_TOKEN = "ghp_..."');
  process.exit(1);
}

if (!fs.existsSync(VSIX_PATH)) {
  console.error(`❌ VSIX not found: ${VSIX_PATH}`);
  console.error('   Run npm run release:package first.');
  process.exit(1);
}

// Parse CHANGELOG for this version's notes
let releaseBody;
try {
  releaseBody = execSync(`node "${path.join(__dirname, 'parse_changelog.js')}" ${VERSION}`, {
    encoding: 'utf8',
  }).trim();
} catch (e) {
  console.error('❌ Failed to parse CHANGELOG:', e.message);
  process.exit(1);
}

function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'virgo-publish-github',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function uploadAsset(uploadUrl, filePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);
    const url = new URL(uploadUrl.replace('{?name,label}', `?name=${encodeURIComponent(fileName)}`));
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'virgo-publish-github',
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileData.length,
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    });
    req.on('error', reject);
    req.write(fileData);
    req.end();
  });
}

async function run() {
  const vsixSize = (fs.statSync(VSIX_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`📦 Creating GitHub Release ${TAG} for ${OWNER}/${REPO}...`);
  console.log(`   VSIX: ${path.basename(VSIX_PATH)} (${vsixSize} MB)`);
  console.log(`   Notes: ${releaseBody.split('\n').length} lines from CHANGELOG.md`);

  const release = await apiRequest('POST', `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: TAG,
    name: TAG,
    body: releaseBody,
    draft: false,
    prerelease: false,
  });

  if (release.status !== 201) {
    console.error(`❌ Failed to create release (HTTP ${release.status}): ${release.body.message}`);
    if (release.body.errors) console.error(JSON.stringify(release.body.errors));
    process.exit(1);
  }

  console.log(`✅ Release created: ${release.body.html_url}`);

  console.log(`⬆️  Uploading ${path.basename(VSIX_PATH)}...`);
  const upload = await uploadAsset(release.body.upload_url, VSIX_PATH);

  if (upload.status !== 201) {
    console.error(`❌ Asset upload failed (HTTP ${upload.status}): ${upload.body.message}`);
    process.exit(1);
  }

  console.log(`✅ VSIX uploaded: ${upload.body.browser_download_url}`);
  console.log(`\n🎉 Release live at: ${release.body.html_url}`);
}

run().catch(e => { console.error(e); process.exit(1); });
