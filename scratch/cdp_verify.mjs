import { chromium } from 'playwright-core';

async function verify() {
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    console.log('[VERIFY] Connected to CDP.');
    
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          try {
            const hasStore = await frame.evaluate(() => {
                return !!(window.store || window.__debug?.store);
            }).catch(() => false);
            
            if (hasStore) {
              console.log(`[MATCH] Found store in: ${frame.url()}`);
              
              // Test Refresh
              console.log('[ACTION] Triggering REFRESH_VOICES...');
              await frame.evaluate(() => {
                const s = window.store || window.__debug?.store;
                s.patchState({ isLoadingVoices: true });
                const ctrl = window.playbackController || window.__debug?.playbackController;
                if (ctrl) ctrl.refreshVoices();
              });
              
              console.log('[WAIT] Waiting for sync...');
              await new Promise(r => setTimeout(r, 3000));
              
              const finalState = await frame.evaluate(() => {
                const s = window.store?.state || window.__debug?.store?.getState();
                return { 
                    isLoadingVoices: s.isLoadingVoices,
                    neuralCount: s.availableVoices?.neural?.length
                };
              });
              
              console.log(`[FINAL] isLoadingVoices: ${finalState.isLoadingVoices}, neuralCount: ${finalState.neuralCount}`);
              if (finalState.isLoadingVoices === false) {
                  console.log('[SUCCESS] Voice Sync Stabilization Verified! Lock released.');
              }
            }
          } catch (e) {}
        }
      }
    }
    await browser.close();
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
  }
}

verify();
