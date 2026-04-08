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
 * @returns A stable, unique cache key
 */
export function generateCacheKey(
    text: string,
    voiceId: string,
    rate: number,
    docUri: string | null = 'global'
): string {
    // 1. Normalize Text: Trim and remove duplicate whitespace
    const cleanText = text.trim().replace(/\s+/g, ' ');

    // 2. Normalize Rate: Round to 2 decimal places to prevent "1.0000001" issues
    const cleanRate = rate.toFixed(2);

    // 3. Normalize VoiceId: Ensure lowercase
    const cleanVoice = voiceId.toLowerCase();

    // 4. Normalize URI: Handle null/undefined
    const cleanUri = (docUri || 'global').replace(/[\\/]/g, '_');

    // Combine into a raw string
    // Format: [Voice]_[Rate]_[DocHash]_[TextHash]
    const raw = `${cleanVoice}|${cleanRate}|${cleanUri}|${cleanText}`;

    // Simple hash function for the text (since we don't have crypto/crypto in all environments easily)
    // We prioritize readability and debugging for now, or use a basic djb2 if needed.
    // For now, let's keep it relatively human-readable for the manifest audit.
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
