/**
 * SpeechProcessor: Stateless utility for text sanitization.
 * Used at the "Sound Generation Gate" to ensure human-friendly audio.
 */

export function cleanForSpeech(text: string): string {
    if (!text) { return ''; }

    // 1. Remove URI components but keep the label: [config.json](file:///...) -> config.json
    let cleaned = text.replace(/\[([^\]]+)\]\((?:file|https?):\/\/[^\s)]+\)/g, '$1');

    // 2. Filter Emojis: Remove pictographics, flags, and skin tones so they aren't spoken (Issue #28)
    // - Extended_Pictographic: Common emojis
    // - Regional_Indicator: Flag components
    // - \u{1F3FB}-\u{1F3FF}: Skin tone modifiers
    cleaned = cleaned.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}]/gu, '');

    // 3. Cleanup: Remove double spaces potentially left by missing emojis
    cleaned = cleaned.replace(/\s\s+/g, ' ');

    return cleaned.trim();
}
