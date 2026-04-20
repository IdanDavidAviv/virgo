
import { chromium } from 'playwright-core';

async function main() {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    for (const context of contexts) {
        const pages = context.pages();
        for (const page of pages) {
            console.log(`Page: ${await page.title()} (${page.url()})`);
            const frames = page.frames();
            for (const frame of frames) {
                if (frame.url().includes('vscode-webview')) {
                    console.log(`  Webview Frame: ${frame.url()}`);
                }
            }
        }
    }
    await browser.close();
}

main().catch(console.error);
