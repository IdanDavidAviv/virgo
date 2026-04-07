import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import fs from 'fs';
import path from 'path';

async function main() {
    const userHome = process.env.USERPROFILE || process.env.HOME || "";
    const registryPath = path.join(userHome, ".gemini", "antigravity", "read_aloud", "active_servers.json");
    const manifest = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const instance = manifest[0];
    
    console.log(`[TEST] Probing Bridge: ${instance.url}`);
    const transport = new SSEClientTransport(new URL(instance.url));
    const client = new Client({ name: "test-discovery", version: "1.0.0" }, { capabilities: {} });
    
    try {
        await client.connect(transport);
        console.log("[TEST] Handshake: SUCCESS");
        const resources = await client.listResources();
        console.log("[TEST] Resource Catalog:");
        console.log(JSON.stringify(resources, null, 2));
        
        // Proper lifecycle closure
        await client.close();
        await transport.close();
        console.log("[TEST] Finalization: SUCCESS (Handle closed)");
        process.exit(0);
    } catch (err) {
        console.error(`[TEST] Handshake: FAILED - ${err.message}`);
        try { await client.close(); await transport.close(); } catch(e) {}
        process.exit(1);
    }
}
main();
