import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import protocols from './protocols.json';

export const VIRGO_PROTOCOLS: Record<string, string> = protocols;

/**
 * High-Integrity Protocol Hydrator
 * 
 * Ensures the global Antigravity protocol store is hydrated and 
 * synchronized with the extension's behavioral DNA.
 * 
 * @param logger Optional logger for diagnostic output
 * @param virgoRootName Optional override for the storage root directory
 */
export function hydrateProtocols(logger?: (msg: string) => void, virgoRootName?: string): void {
    const log = logger || ((msg: string) => console.log(msg));

    try {
        // 1. Resolve global Antigravity root path (strictly Home directory)
        const userHome = os.homedir();
        const rootName = virgoRootName || process.env.VIRGO_ROOT || 'virgo';
        const globalProtocolsDir = path.join(userHome, '.gemini', 'antigravity', rootName, 'protocols');

        // 2. Ensure directory existence
        if (!fs.existsSync(globalProtocolsDir)) {
            log(`[HYDRATOR] Creating global protocols directory: ${globalProtocolsDir}`);
            fs.mkdirSync(globalProtocolsDir, { recursive: true });
        }

        // 3. Coordinate Hydration (Atomic File Verification)
        for (const [filename, content] of Object.entries(VIRGO_PROTOCOLS)) {
            const targetPath = path.join(globalProtocolsDir, filename);
            let needsWipe = false;

            if (fs.existsSync(targetPath)) {
                // Check for version parity (simple content comparison)
                const existing = fs.readFileSync(targetPath, 'utf-8');
                if (existing !== content) {
                    log(`[HYDRATOR] Version Drift: ${filename} is out of sync. Re-hydrating.`);
                    needsWipe = true;
                }
            } else {
                log(`[HYDRATOR] Missing Asset: ${filename} not found. Hydrating.`);
                needsWipe = true;
            }

            if (needsWipe) {
                fs.writeFileSync(targetPath, content, 'utf-8');
            }
        }

        log('✅ [HYDRATOR] Global Protocols Synchronized Successfully.');
    } catch (err: any) {
        log(`❌ [HYDRATOR] Critical failure during protocol hydration: ${err.message}`);
    }
}
