/**
 * SpeechProcessor: Stateless utility for text sanitization.
 * Used at the "Sound Generation Gate" to ensure human-friendly audio.
 */

export function cleanForSpeech(text: string): string {
    if (!text) { return ''; }

    // 1. Remove URI components but keep the label: [config.json](file:///...) -> config.json
    let cleaned = text.replace(/\[([^\]]+)\]\((?:file|https?):\/\/[^\s)]+\)/g, '$1');

    // 2. Filter Emojis: Remove pictographics, flags, and skin tones so they aren't spoken (Issue #28)
    cleaned = cleaned.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}]/gu, '');

    // 3. Filter XML/SSML symbols: Escape/Remove characters that break neural TTS XML wrapping (Issue #36)
    // - Escape ampersands first to prevent recursive escaping
    // - Replace < and > with spaces
    // - Strip double/single quotes to ensure SSML attribute safety
    cleaned = cleaned.replace(/&/g, '&amp;')
                     .replace(/[<>]/g, ' ')
                     .replace(/["']/g, '');

    // 4. Cleanup: Remove double spaces potentially left by missing symbols
    cleaned = cleaned.replace(/\s\s+/g, ' ');

    return cleaned.trim();
}
