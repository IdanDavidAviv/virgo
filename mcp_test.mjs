import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

async function test() {
    const transport = new SSEClientTransport(new URL("http://localhost:7414/sse"));
    const client = new Client({ name: "mcp-verifier", version: "1.0.0" }, {
        capabilities: { resources: {} }
    });

    console.log("Connecting to bridge...");
    await client.connect(transport);
    console.log("Connected!");

    console.log("Listing resources...");
    const resources = await client.listResources();
    console.log("Resources:", JSON.stringify(resources, null, 2));

    if (resources.resources && resources.resources.length > 0) {
        const uri = resources.resources[0].uri;
        console.log(`Reading resource: ${uri}...`);
        const content = await client.readResource({ uri });
        console.log("Content Prefix:", JSON.stringify(content).substring(0, 200));
    }

    process.exit(0);
}

test().catch(err => {
    console.error("Test Failed:", err);
    process.exit(1);
});
