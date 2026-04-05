const fs = require('fs');
const path = require('path');
const os = require('os');

const ANTIGRAVITY_ROOT = path.join(os.homedir(), '.gemini', 'antigravity');
const READ_ALOUD_ROOT = path.join(ANTIGRAVITY_ROOT, 'read_aloud');
const PROTOCOLS_DIR = path.join(READ_ALOUD_ROOT, 'protocols');

const protocolsPath = path.join(__dirname, '..', 'src', 'common', 'protocols.json');
const protocols = JSON.parse(fs.readFileSync(protocolsPath, 'utf-8'));


function setup() {
  console.log('🚀 Initializing Global Read Aloud Protocols...');
  console.log(`[SETUP] Target: ${PROTOCOLS_DIR}`);

  // 1. Ensure directories exist
  [ANTIGRAVITY_ROOT, READ_ALOUD_ROOT, PROTOCOLS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      console.log(`[SETUP] Creating directory: ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  // 2. Hydrate Protocols
  Object.entries(protocols).forEach(([name, content]) => {
    const filePath = path.join(PROTOCOLS_DIR, name);
    console.log(`[SETUP] Hydrating protocol: ${name}`);
    fs.writeFileSync(filePath, content);
  });

  console.log('✅ Global Protocols Synchronized! Use `read_aloud_boot` to begin.');
}

setup();
