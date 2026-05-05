import * as https from 'https';
import { StateStore } from '@core/stateStore';

/**
 * [T-102] UpdateChecker — Single-shot GitHub Releases version poller.
 *
 * Strategy:
 *  - Fires once at extension activation (no polling loop, no background timers after resolve).
 *  - Uses a 24h in-memory cache so repeated extension reloads within a session skip the network.
 *  - On success: patches StateStore with latestVersion + updateAvailable.
 *  - On any failure (network, rate-limit, parse): silently no-ops — badge stays grey.
 *
 * Pattern mirrors McpConfigurator.checkConfigurationStatus() / probeLiveness():
 *  fire-and-forget with try/catch, result flows into StateStore → DashboardRelay → webview badge.
 */

const REPO = 'IdanDavidAviv/virgo';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

let _cachedResult: { latestVersion: string; checkedAt: number } | null = null;

/**
 * Compares two semver strings (major.minor.patch).
 * Returns true if `remote` is strictly newer than `local`.
 */
function isNewer(local: string, remote: string): boolean {
    const parse = (v: string) =>
        v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const [lMaj, lMin, lPat] = parse(local);
    const [rMaj, rMin, rPat] = parse(remote);
    if (rMaj !== lMaj) { return rMaj > lMaj; }
    if (rMin !== lMin) { return rMin > lMin; }
    return rPat > lPat;
}

/**
 * Fetches the latest GitHub release tag via HTTPS (no external dependencies).
 * Resolves with the tag name (e.g. "v2.9.5") or rejects on any error.
 */
function fetchLatestTag(): Promise<string> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${REPO}/releases/latest`,
            method: 'GET',
            headers: {
                'User-Agent': 'virgo-extension-update-checker',
                'Accept': 'application/vnd.github.v3+json',
            },
            timeout: 5000,
        };

        const req = https.request(options, (res) => {
            if (res.statusCode === 304) { reject(new Error('304 Not Modified')); return; }
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                reject(new Error(`GitHub API responded with ${res.statusCode}`));
                return;
            }

            let body = '';
            res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    const tag: string = json.tag_name;
                    if (!tag) { reject(new Error('No tag_name in response')); return; }
                    resolve(tag);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * checkForUpdates() — Public entry point called from SpeechProvider constructor.
 *
 * @param currentVersion  The running extension version (from package.json via context).
 * @param stateStore      The active StateStore — result is patched directly.
 * @param logger          Extension logger function.
 */
export function checkForUpdates(
    currentVersion: string,
    stateStore: StateStore,
    logger: (msg: string) => void
): void {
    // [CACHE] Skip network if we checked recently in the same process lifetime
    if (_cachedResult && Date.now() - _cachedResult.checkedAt < CACHE_TTL_MS) {
        const { latestVersion } = _cachedResult;
        const updateAvailable = isNewer(currentVersion, latestVersion);
        logger(`[UPDATE] Cache hit — latest=${latestVersion} current=${currentVersion} updateAvailable=${updateAvailable}`);
        stateStore.patchState({ latestVersion, updateAvailable });
        return;
    }

    fetchLatestTag()
        .then((tag) => {
            const latestVersion = tag.replace(/^v/, ''); // normalize: "v2.9.5" → "2.9.5"
            _cachedResult = { latestVersion, checkedAt: Date.now() };
            const updateAvailable = isNewer(currentVersion, latestVersion);
            logger(`[UPDATE] ✅ latest=${latestVersion} current=${currentVersion} updateAvailable=${updateAvailable}`);
            stateStore.patchState({ latestVersion, updateAvailable });
        })
        .catch((err: Error) => {
            // [SILENT FAILURE] Update check is non-critical — never surface errors to the user.
            logger(`[UPDATE] ⚠️ Check failed (non-critical): ${err.message}`);
        });
}
