/**
 * FORENSIC AUDIT SCRIPT (v1.1.0 - Serverless Edition)
 * Run: node forensic_audit.js
 * Checks for: Legacy port leaks, diagnostic log health, and native messaging state.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');

const LEGACY_PORTS = [3001, 3002, 3003];
const LOOPBACK_ADDRS = ['127.0.0.1', '::1'];

function checkPort(host, port) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(500);
        sock.on('connect', () => { sock.destroy(); resolve({ host, port, status: 'LOCKED (Legacy Bridge Conflict!)' }); });
        sock.on('timeout', () => { sock.destroy(); resolve({ host, port, status: 'TIMEOUT' }); });
        sock.on('error', (e) => resolve({ host, port, status: `CLEAN (${e.code})` }));
        sock.connect(port, host);
    });
}

async function run() {
    console.log('\n=== READ ALOUD v1.1.0 FORENSIC AUDIT ===\n');

    // 1. Port Hygiene (Should all be CLEAN now)
    console.log('--- LEGACY PORT HYGIENE (Checks for ghost BridgeServers) ---');
    for (const port of LEGACY_PORTS) {
        for (const host of LOOPBACK_ADDRS) {
            const result = await checkPort(host, port);
            const icon = result.status.includes('CLEAN') ? '✅' : '⚠️';
            console.log(`  ${icon} [${result.status}] ${host}:${port}`);
        }
    }

    // 2. Diagnostic Log Health
    console.log('\n--- DIAGNOSTIC LOG AUDIT ---');
    const logPath = path.join(__dirname, 'diagnostics.log');
    if (fs.existsSync(logPath)) {
        const stats = fs.statSync(logPath);
        console.log(`  ✅ Found diagnostics.log (${(stats.size / 1024).toFixed(2)} KB)`);
        
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        const lastLines = lines.slice(-5);
        
        console.log('  --- Last 5 Log Signals ---');
        lastLines.forEach(l => console.log(`    > ${l}`));

        const hasNative = content.includes('[BOOT] Native API');
        console.log(`\n  --- NATIVE HANDSHAKE STATUS ---`);
        console.log(`  ${hasNative ? '✅' : '❌'} Native Bootstrap Detected: ${hasNative ? 'YES' : 'NO'}`);
    } else {
        console.log('  ❌ diagnostics.log NOT FOUND. (Run the extension first)');
    }

    console.log('\n=== END OF AUDIT ===\n');
    console.log('POST-MIGRATION EXPECTATIONS:');
    console.log('  - All legacy ports (3001-3003) MUST show CLEAN.');
    console.log('  - Native Bootstrap MUST show YES if the dashboard was opened.');
    console.log('  - If a port is LOCKED, kill the process using that port (likely a zombie v1.0.3 BridgeServer).');
}

run();
