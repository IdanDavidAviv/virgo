const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const mode = process.argv.find(arg => arg.startsWith('--mode='))?.split('=')[1] || (watch ? 'development' : 'production');

async function build() {
    console.log(`🛠️ Mode: ${mode}${watch ? ' (Watch)' : ''}`);

    // 0. Prepare dist/media
    const distMedia = path.join(__dirname, 'dist', 'media');
    if (!fs.existsSync(distMedia)) {
        fs.mkdirSync(distMedia, { recursive: true });
    }

    // Copy static assets
    const assets = ['style.css', 'speechEngine.html', 'icon.svg', 'icon-dev.svg'];
    assets.forEach(asset => {
        const src = path.join(__dirname, 'src', 'webview', asset);
        const dest = path.join(distMedia, asset);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            console.log(`✅ Copied ${asset} to ${distMedia}`);
        } else {
            console.warn(`⚠️ Warning: Static asset ${asset} not found in src/webview/`);
        }
    });

    // Icon: dev build gets an orange "D" badge, prod gets the clean icon
    const iconSrc = mode === 'development'
        ? path.join(__dirname, 'src', 'webview', 'icon-dev.svg')
        : path.join(__dirname, 'src', 'webview', 'icon.svg');
    const iconDest = path.join(__dirname, 'dist', 'icon.svg');
    if (fs.existsSync(iconSrc)) {
        fs.copyFileSync(iconSrc, iconDest);
        console.log(`✅ Icon: ${mode === 'development' ? 'icon-dev.svg [DEV badge]' : 'icon.svg [prod]'} → dist/icon.svg`);
    }

    const commonAlias = {
        '@extension': path.resolve(__dirname, 'src/extension'),
        '@core': path.resolve(__dirname, 'src/extension/core'),
        '@vscode': path.resolve(__dirname, 'src/extension/vscode'),
        '@webview': path.resolve(__dirname, 'src/webview'),
        '@common': path.resolve(__dirname, 'src/common'),
    };

    // 1. Extension Host Bundle (Node.js)
    const nodeConfig = {
        entryPoints: ['./src/extension/vscode/extension.ts'],
        bundle: true,
        alias: {
            '@extension': path.join(__dirname, 'src/extension'),
            '@core': path.join(__dirname, 'src/extension/core'),
            '@vscode': path.join(__dirname, 'src/extension/vscode'),
            '@webview': path.join(__dirname, 'src/webview'),
            '@common': path.join(__dirname, 'src/common'),
        },
        outfile: './dist/extension.js',
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        minify: mode === 'production',
        sourcemap: true,
    };

    // 2. Dashboard WebView Bundle (Browser)
    const browserConfig = {
        entryPoints: {
            app: './src/webview/index.ts'
        },
        bundle: true,
        alias: commonAlias,
        outdir: './dist/media',
        format: 'iife',
        platform: 'browser',
        minify: mode === 'production',
        sourcemap: true,
    };

    // 3. Standalone MCP Server (Node.js)
    const mcpConfig = {
        entryPoints: ['./src/extension/mcp/mcpStandalone.ts'],
        bundle: true,
        alias: commonAlias,
        outfile: './dist/mcp-standalone.js',
        platform: 'node',
        format: 'esm',
        minify: mode === 'production',
        sourcemap: true,
        banner: {
            js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        },
    };

    const watchPlugin = {
        name: 'watch-plugin',
        setup(build) {
            build.onEnd(result => {
                if (result.errors.length > 0) {
                    console.log(`❌ [watch] build failed: ${result.errors.length} errors`);
                } else {
                    console.log(`✅ [watch] build finished`);
                }
            });
        },
    };

    if (watch) {
        const nodeCtx = await esbuild.context({ ...nodeConfig, plugins: [watchPlugin] });
        const browserCtx = await esbuild.context({ ...browserConfig, plugins: [watchPlugin] });
        const mcpCtx = await esbuild.context({ ...mcpConfig, plugins: [watchPlugin] });
        await Promise.all([nodeCtx.watch(), browserCtx.watch(), mcpCtx.watch()]);
        console.log('👀 Watching for changes in development mode...');
    } else {
        await Promise.all([
            esbuild.build({ ...nodeConfig, plugins: [watchPlugin] }),
            esbuild.build({ ...browserConfig, plugins: [watchPlugin] }),
            esbuild.build({ ...mcpConfig, plugins: [watchPlugin] })
        ]);
        console.log(`🚀 ${mode.charAt(0).toUpperCase() + mode.slice(1)} build complete!`);
    }
}

build().catch(e => {
    console.error('❌ Build failed', e);
    process.exit(1);
});
