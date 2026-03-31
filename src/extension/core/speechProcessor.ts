/**
 * SpeechProcessor: Stateless utility for text sanitization.
 * Used at the "Sound Generation Gate" to ensure human-friendly audio.
 */

export function cleanForSpeech(text: string): string {
    if (!text) { return ''; }

    // 1. Remove URI components but keep the label: [config.json](file:///...) -> config.json
    // regex: \[([^\]]+)\]\((?:file|https?):\/\/[^\s)]+\)/g
    let cleaned = text.replace(/\[([^\]]+)\]\((?:file|https?):\/\/[^\s)]+\)/g, '$1');

    // 2. Performance: Clean up trailing punctuation if it was before the link
    // e.g. "Reviewing [file.ts](file:///...) changes." -> "Reviewing file.ts changes."
    
    return cleaned.trim();
}
