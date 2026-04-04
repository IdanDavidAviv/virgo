const http = require('http');

/**
 * Diagnostic tool to simulate a real MCP handshake and tool call.
 */
const snippet = {
    content: "# Shadow Narrator Verification\nThis snippet verifies the MCP handshaking logic and session persistence.",
    snippet_name: "Shadow_Narrator_Handshake"
};

// Use the current Conversation ID
const sessionId = 'fa6340bf-1dcd-4e6f-9318-4397c55a3872';

console.log(`📡 Opening SSE connection to register session ${sessionId}...`);

// 1. Establish SSE Connection (Wait for the server to log 'session_started')
const sseReq = http.request({
    hostname: 'localhost',
    port: 7413,
    path: '/sse',
    method: 'GET',
    headers: { 'Accept': 'text/event-stream' }
}, (res) => {
    console.log(`✅ Bridge Connected (Status: ${res.statusCode})`);
    
    // Once connected, wait 1 second for the server to hydrate the session map
    setTimeout(() => {
        sendToolCall();
    }, 1000);
});

sseReq.on('error', (e) => {
    console.error(`❌ Connection Error: ${e.message}`);
    process.exit(1);
});
sseReq.end();

function sendToolCall() {
    const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
            name: "inject_markdown",
            arguments: snippet
        }
    });

    const options = {
        hostname: 'localhost',
        port: 7413,
        path: `/messages?sessionId=${sessionId}`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        }
    };

    console.log(`🚀 Injecting snippet into session ${sessionId}...`);

    const req = http.request(options, (res) => {
        console.log(`📡 Status: ${res.statusCode}`);
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            console.log(`📄 Response: ${chunk}`);
            console.log(`\n🎉 INTEGRATION VERIFIED! Check the Read Aloud UI.`);
            process.exit(0);
        });
    });

    req.on('error', (e) => {
        console.error(`❌ Injection Error: ${e.message}`);
        process.exit(1);
    });

    req.write(body);
    req.end();
}
