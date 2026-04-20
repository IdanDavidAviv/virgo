import { connectToCDP, findSovereignTarget } from '../scripts/cdp-controller.mjs';

async function main() {
    const browser = await connectToCDP();
    const webview = await findSovereignTarget(browser, 'webview', true);
    
    if (!webview) {
        console.error('Webview not found');
        process.exit(1);
    }
    
    console.log('Found webview:', webview.url());
    
    // Inject log listener
    await webview.evaluate(() => {
        console.log('--- CDP AUDIT START ---');
        // Watch for store changes
        const store = window.__debug?.store;
        if (store) {
            let lastState = JSON.stringify(store.getState());
            setInterval(() => {
                const newState = JSON.stringify(store.getState());
                if (newState !== lastState) {
                    const diff = JSON.parse(newState);
                    console.log('[STORE-DIFF]', {
                        isPlaying: diff.isPlaying,
                        isPaused: diff.isPaused,
                        playbackIntentId: diff.playbackIntentId,
                        isAwaitingSync: window.__debug?.controller?.getState()?.isAwaitingSync
                    });
                    lastState = newState;
                }
            }, 100);
        }
    });

    // Click Play
    console.log('Clicking Play...');
    await webview.click('#btn-play');
    
    // Wait for 10 seconds to collect logs
    await new Promise(r => setTimeout(r, 10000));
    
    await browser.close();
}

main().catch(console.error);
