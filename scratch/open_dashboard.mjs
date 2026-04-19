import { chromium } from 'playwright-core';

async function openDashboard() {
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    console.log('[VERIFY] Connected to CDP.');
    
    const contexts = browser.contexts();
    for (const context of contexts) {
      const pages = context.pages();
      for (const page of pages) {
        const title = await page.title().catch(() => '');
        if (title.includes('Extension Development Host')) {
          console.log(`[MATCH] Found Host: ${title}`);
          await page.bringToFront();
          await page.keyboard.press('Control+Shift+P');
          await new Promise(r => setTimeout(r, 400));
          await page.keyboard.type('Read Aloud: Show Read Aloud Dashboard', { delay: 20 });
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.press('Enter');
          console.log('[SUCCESS] Dashboard command dispatched.');
        }
      }
    }
    await browser.close();
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
  }
}

openDashboard();
