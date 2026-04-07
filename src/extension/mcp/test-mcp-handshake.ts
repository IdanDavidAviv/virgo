import axios from 'axios';
import { EventSource } from 'eventsource';

async function auditHandshake() {
    console.log("🚀 Starting MCP Handshake Audit...");
    console.log("🔗 Connecting to http://localhost:7414/sse...");

    const es = new EventSource('http://localhost:7414/sse');
    
    es.onopen = () => {
        console.log("✅ SSE Connection established.");
    };

    es.addEventListener('endpoint', async (event: any) => {
        const endpoint = event.data;
        console.log(`📡 POST Endpoint discovered: ${endpoint}`);
        
        try {
            console.log("📩 Sending 'initialize' request...");
            const response = await axios.post(`http://localhost:7414${endpoint}`, {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {},
                    clientInfo: { name: "AuditTool", version: "1.0.0" }
                }
            });

            console.log("📥 Handshake Response Received:");
            console.log(JSON.stringify(response.data, null, 2));
            
            const capabilities = response.data.result?.capabilities;
            if (capabilities) {
                console.log("\n📦 Announced Capabilities:");
                console.log(` - Resources: ${!!capabilities.resources}`);
                console.log(` - Tools: ${!!capabilities.tools}`);
                console.log(` - Prompts: ${!!capabilities.prompts}`);
            }

            process.exit(0);
        } catch (error: any) {
            console.error("❌ Handshake Failed:", error.response?.data || error.message);
            process.exit(1);
        }
    });

    es.onerror = (err) => {
        console.error("❌ SSE Connection Error. Is the bridge running?", err);
        process.exit(1);
    };

    // Timeout after 10s
    setTimeout(() => {
        console.error("🕒 Audit Timed Out.");
        process.exit(1);
    }, 10000);
}

auditHandshake();
