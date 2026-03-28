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
    const assets = ['style.css', 'speechEngine.html'];
    assets.forEach(asset => {
        const src = path.join(__dirname, 'media', asset);
        const dest = path.join(distMedia, asset);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            console.log(`✅ Copied ${asset} to ${distMedia}`);
        }
    });

    // Icon: dev build gets an orange "D" badge, prod gets the clean icon
    const iconSrc = mode === 'development'
        ? path.join(__dirname, 'media', 'icon-dev.svg')
        : path.join(__dirname, 'media', 'icon.svg');
    const iconDest = path.join(__dirname, 'dist', 'icon.svg');
    if (fs.existsSync(iconSrc)) {
        fs.copyFileSync(iconSrc, iconDest);
        console.log(`✅ Icon: ${mode === 'development' ? 'icon-dev.svg [DEV badge]' : 'icon.svg [prod]'} → dist/icon.svg`);
    }

    // 1. Extension Host Bundle (Node.js)
    const nodeConfig = {
        entryPoints: ['./src/extension.ts'],
        bundle: true,
        outfile: './dist/extension.js',
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        minify: mode === 'production',
        sourcemap: true,
    };

    // 2. Dashboard WebView Bundle (Browser)
    const browserConfig = {
        entryPoints: ['./media/dashboard.js'],
        bundle: true,
        outfile: './dist/media/dashboard.js',
        format: 'iife',
        platform: 'browser',
        minify: mode === 'production',
        sourcemap: true,
    };

    if (watch) {
        const nodeCtx = await esbuild.context(nodeConfig);
        const browserCtx = await esbuild.context(browserConfig);
        await Promise.all([nodeCtx.watch(), browserCtx.watch()]);
        console.log('👀 Watching for changes in development mode...');
    } else {
        await Promise.all([
            esbuild.build(nodeConfig),
            esbuild.build(browserConfig)
        ]);
        console.log(`🚀 ${mode.charAt(0).toUpperCase() + mode.slice(1)} build complete!`);
    }
}

build().catch(e => {
    console.error('❌ Build failed', e);
    process.exit(1);
});
