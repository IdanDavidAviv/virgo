const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

async function build() {
    // 0. Prepare dist/media
    const distMedia = path.join(__dirname, 'dist', 'media');
    if (!fs.existsSync(distMedia)) {
        fs.mkdirSync(distMedia, { recursive: true });
    }

    // Copy static assets
    const assets = ['style.css', 'speechEngine.html'];
    assets.forEach(asset => {
        const src = path.join(__dirname, 'media', asset);
        const dest = path.join(distMedia, asset);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            console.log(`✅ Copied ${asset} to ${distMedia}`);
        }
    });

    // 1. Extension Host Bundle (Node.js)
    const nodeConfig = {
        entryPoints: ['./src/extension.ts'],
        bundle: true,
        outfile: './dist/extension.js',
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        minify: true,
        sourcemap: true,
    };

    // 2. Dashboard WebView Bundle (Browser)
    const browserConfig = {
        entryPoints: ['./media/dashboard.js'],
        bundle: true,
        outfile: './dist/media/dashboard.js',
        format: 'iife',
        platform: 'browser',
        minify: true,
        sourcemap: true,
    };

    if (watch) {
        const nodeCtx = await esbuild.context(nodeConfig);
        const browserCtx = await esbuild.context(browserConfig);
        await Promise.all([nodeCtx.watch(), browserCtx.watch()]);
        console.log('👀 Watching for changes...');
    } else {
        await Promise.all([
            esbuild.build(nodeConfig),
            esbuild.build(browserConfig)
        ]);
        console.log('🚀 Build complete!');
    }
}

build().catch(e => {
    console.error('❌ Build failed', e);
    process.exit(1);
});
