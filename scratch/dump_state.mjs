import { chromium } from 'playwright-core';

async function dumpState() {
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    console.log('[AUDIT] Connected to CDP.');
    
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          try {
            const state = await frame.evaluate(() => {
                const s = window.store || window.__debug?.store;
                if (!s) return null;
                const state = s.state || s.getState();
                return {
                    selectedVoice: state.selectedVoice,
                    engineMode: state.engineMode,
                    isLoadingVoices: state.isLoadingVoices,
                    availableVoices: {
                        local: state.availableVoices?.local?.length,
                        neural: state.availableVoices?.neural?.length
                    }
                };
            }).catch(() => null);
            
            if (state) {
              console.log(`[STATE] Frame: ${frame.url()}`);
              console.log(JSON.stringify(state, null, 2));
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

dumpState();
