
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function test() {
    console.log("Connecting to bridge...");
    const transport = new SSEClientTransport(new URL("http://localhost:7414/sse"));
    const client = new Client(
        { name: "test-client", version: "1.0.0" },
        { capabilities: { resources: {} } }
    );

    try {
        await client.connect(transport);
        console.log("Handshake successful.");
        
        console.log("Listing resources...");
        const resources = await client.listResources();
        console.log("Resources:", JSON.stringify(resources, null, 2));

        console.log("Listing resource templates...");
        const templates = await client.listResourceTemplates();
        console.log("Templates:", JSON.stringify(templates, null, 2));

        process.exit(0);
    } catch (err) {
        console.error("Error:", err);
        process.exit(1);
    }
}

test();
