/**
 * FORENSIC AUDIT SCRIPT
 * Run: node forensic_audit.js
 * Checks for: Port locks, process zombies, loopback availability
 */
const http = require('http');
const net = require('net');

const PORTS_TO_CHECK = [3001, 3002, 3003];
const LOOPBACK_ADDRS = ['127.0.0.1', '::1', '0.0.0.0'];

function checkPort(host, port) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(1000);
        sock.on('connect', () => { sock.destroy(); resolve({ host, port, status: 'IN USE (something is listening)' }); });
        sock.on('timeout', () => { sock.destroy(); resolve({ host, port, status: 'TIMEOUT (blocked or no listener)' }); });
        sock.on('error', (e) => resolve({ host, port, status: `FREE (${e.code})` }));
        sock.connect(port, host);
    });
}

function checkHTTPReachable(host, port) {
    return new Promise((resolve) => {
        const req = http.get({ host, port, path: '/', timeout: 1500 }, (res) => {
            resolve({ host, port, httpStatus: res.statusCode, ok: true });
        });
        req.on('error', (e) => resolve({ host, port, httpStatus: null, ok: false, error: e.code }));
        req.on('timeout', () => { req.destroy(); resolve({ host, port, httpStatus: null, ok: false, error: 'TIMEOUT' }); });
    });
}

async function run() {
    console.log('\n=== FORENSIC AUDIT REPORT ===\n');

    // 1. Port Scan
    console.log('--- PORT SCAN ---');
    for (const port of PORTS_TO_CHECK) {
        for (const host of LOOPBACK_ADDRS) {
            const result = await checkPort(host, port);
            console.log(`  [${result.status}] ${host}:${port}`);
        }
    }

    // 2. HTTP Bridge Connectivity Test (must be running the extension first)
    console.log('\n--- HTTP BRIDGE REACHABILITY (port 3001) ---');
    console.log('  (This only works if the extension is running. If all show errors, the bridge is down.)');
    for (const host of LOOPBACK_ADDRS) {
        const result = await checkHTTPReachable(host, 3001);
        const icon = result.ok ? '✅' : '❌';
        console.log(`  ${icon} http://${host}:3001 → ${result.ok ? `HTTP ${result.httpStatus}` : result.error}`);
    }

    console.log('\n=== END OF AUDIT ===\n');
    console.log('WHAT TO LOOK FOR:');
    console.log('  - 127.0.0.1 shows TIMEOUT or ERROR while 0.0.0.0 is IN USE → VPN is rerouting loopback (CONFIRMED ISSUE)');
    console.log('  - All ports FREE while extension activated → Bridge failed to start (check diagnostics.log)');
    console.log('  - Multiple IN USE on same port → Ghost/zombie process from a crash');
}

run();
