const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '../../../..');
const distDir = path.join(rootDir, 'dist');
const mcpPackageDir = path.join(rootDir, 'dist-npm-mcp');
const packageJsonPath = path.join(rootDir, 'package.json');

// Read the main extension's version
const mainPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = mainPackageJson.version;

console.log(`📦 Packaging virgo-mcp v${version}...`);

// Ensure dist-npm-mcp directory exists
if (fs.existsSync(mcpPackageDir)) {
    fs.rmSync(mcpPackageDir, { recursive: true, force: true });
}
fs.mkdirSync(mcpPackageDir, { recursive: true });

// Copy the bundled script
const sourceScript = path.join(distDir, 'mcp-standalone.js');
const targetScript = path.join(mcpPackageDir, 'index.js');

if (!fs.existsSync(sourceScript)) {
    console.error('❌ Error: dist/mcp-standalone.js not found. Please run "npm run build" first.');
    process.exit(1);
}

fs.copyFileSync(sourceScript, targetScript);
console.log('✅ Copied standalone script to package directory.');

// Generate a lightweight package.json
const mcpPackageJson = {
    name: "virgo-mcp",
    version: version,
    description: "Standalone MCP Server for Virgo / Read Aloud",
    bin: "index.js",
    main: "index.js",
    author: mainPackageJson.author || mainPackageJson.publisher,
    license: mainPackageJson.license || "MIT",
    engines: {
        node: ">=18"
    }
};

fs.writeFileSync(
    path.join(mcpPackageDir, 'package.json'),
    JSON.stringify(mcpPackageJson, null, 2)
);
console.log('✅ Generated package.json.');

console.log('🚀 Ready to publish. Running npm publish...');

try {
    // Run npm publish in the package directory
    execSync('npm publish --access public', { stdio: 'inherit', cwd: mcpPackageDir });
    console.log(`🎉 Successfully published virgo-mcp v${version}!`);
} catch (error) {
    console.error('❌ Failed to publish virgo-mcp. Make sure you are logged into npm.');
    process.exit(1);
}
