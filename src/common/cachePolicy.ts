/**
 * Cache Policy & Key Generation Strategy
 * 
 * This file is the Source of Truth for cache key generation.
 * Both the Extension Host and Webview must use these functions to ensure
 * consistency and avoid "Split-Brain" cache misses.
 */

/**
 * Normalizes input parameters and generates a unique hash for a sentence.
 * 
 * @param text The sentence text to synthesize
 * @param voiceId The unique identifier for the voice (e.g. Edge TTS name)
 * @param rate The playback rate (will be normalized to 2 decimal places)
 * @param docUri The URI of the document (prevents collisions across different files with same text)
 * @param isNeural Whether this is for a neural voice (rate is always 1.0 for neural cache keys)
 * @returns A stable, unique cache key
 */
export function generateCacheKey(
    text: string,
    voiceId: string,
    rate: number,
    docUri: string | null = 'global',
    isNeural: boolean = false
): string {
    // 1. Normalize Text: Trim and remove duplicate whitespace
    const cleanText = text.trim().replace(/\s+/g, ' ');

    // 2. Normalize Rate: For neural audio, we always synthesize at 1.0x to allow relative scaling in the webview.
    // This allows the speed slider to work instantly without re-synthesizing.
    const effectiveRateForCache = isNeural ? 1.0 : rate;
    const cleanRate = effectiveRateForCache.toFixed(2);

    // 3. Normalize VoiceId: Ensure lowercase
    const cleanVoice = voiceId.toLowerCase();

    // 4. Normalize URI: Handle null/undefined
    const cleanUri = (docUri || 'global').replace(/[\\/]/g, '_');

    // Simple hash function for the text
    const textHash = simpleHash(cleanText);
    const uriHash = simpleHash(cleanUri);

    return `${cleanVoice}_${cleanRate}_${uriHash}_${textHash}`;
}

/**
 * Simple hash function (djb2) to keep keys at a manageable length
 * and avoid characters that are illegal in file paths/DB keys.
 */
function simpleHash(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 33) ^ str.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
}

/**
 * Version of the cache format.
 * Incrementing this will effectively invalidate all existing caches.
 */
export const CACHE_VERSION = 'v2';
