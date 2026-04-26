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

let scriptContent = fs.readFileSync(sourceScript, 'utf8');
if (!scriptContent.startsWith('#!/usr/bin/env node')) {
    scriptContent = '#!/usr/bin/env node\n' + scriptContent;
}

fs.writeFileSync(targetScript, scriptContent, 'utf8');
console.log('✅ Copied standalone script to package directory and verified hashbang.');

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

// Load .env file manually to avoid adding a production dependency
// We look for .env locally within the mcp_publisher skill directory to keep the project root clean
const envPath = path.join(__dirname, '..', '.env');
let envTokens = {};
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
            envTokens[match[1]] = match[2].replace(/(^['"]|['"]$)/g, '');
        }
    });
}

const npmToken = process.env.NPM_TOKEN || envTokens.NPM_TOKEN;
const envConfig = { ...process.env };

if (npmToken) {
    console.log('🔑 NPM Automation Token found. Publishing headlessly...');
    const npmrcPath = path.join(mcpPackageDir, '.npmrc');
    fs.writeFileSync(npmrcPath, `//registry.npmjs.org/:_authToken=${npmToken}\n`);
} else {
    console.log('⚠️ No NPM_TOKEN found in .env. Falling back to interactive publish (requires TTY).');
}

console.log('🚀 Ready to publish. Running npm publish...');

try {
    // Run npm publish in the package directory
    execSync('npm publish --access public', { 
        stdio: 'inherit', 
        cwd: mcpPackageDir
    });
    console.log(`🎉 Successfully published virgo-mcp v${version}!`);
} catch (error) {
    console.error('❌ Failed to publish virgo-mcp.');
    if (!npmToken) {
        console.error('   Hint: Since you are running without an NPM_TOKEN, this may fail in headless environments (like agents or CI/CD).');
        console.error('   To fix: Create a Classic Automation token in NPM and add NPM_TOKEN=npm_... to your .env file.');
    }
    process.exit(1);
} finally {
    // Clean up temporary .npmrc if it exists
    const npmrcPath = path.join(mcpPackageDir, '.npmrc');
    if (fs.existsSync(npmrcPath)) fs.unlinkSync(npmrcPath);
}
