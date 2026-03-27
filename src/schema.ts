import { z } from 'zod';

// --- Shared Core Types ---

export const VoiceSchema = z.object({
    id: z.string(),
    name: z.string(),
    lang: z.string(),
    gender: z.string().optional()
});

export type Voice = z.infer<typeof VoiceSchema>;

export const ChapterSchema = z.object({
    title: z.string(),
    level: z.number(),
    lineStart: z.number(),
    lineEnd: z.number(),
    text: z.string(),
    sentences: z.array(z.string()),
    // Metadata for precision 1:1 mapping
    sentenceLineMap: z.array(z.number()) 
});

export type Chapter = z.infer<typeof ChapterSchema>;

// --- Extension -> Webview Messages ---

export const StateSyncSchema = z.object({
    command: z.literal('state-sync'),
    activeUri: z.string().nullable(),
    readingUri: z.string().nullable(),
    isPaused: z.boolean(),
    isPlaying: z.boolean()
});

export const ChaptersMessageSchema = z.object({
    command: z.literal('chapters'),
    chapters: z.array(ChapterSchema),
    current: z.number()
});

export const VoicesMessageSchema = z.object({
    command: z.literal('voices'),
    voices: z.array(z.string()), // Local names
    neuralVoices: z.array(VoiceSchema),
    engineMode: z.enum(['local', 'neural'])
});

export const PlayAudioMessageSchema = z.object({
    command: z.literal('playAudio'),
    data: z.instanceof(Uint8Array).or(z.string()), // Support binary Uint8Array or Base64 string fallback
    text: z.string(),
    sentences: z.array(z.string()),
    sentenceIndex: z.number()
});

export const ProgressMessageSchema = z.object({
    command: z.literal('sentenceChanged'),
    sentenceIndex: z.number(),
    text: z.string(),
    sentences: z.array(z.string()).optional()
});

// --- Webview -> Extension Messages ---

export const WebviewCommandSchema = z.discriminatedUnion('command', [
    z.object({ command: z.literal('ready') }),
    z.object({ command: z.literal('play') }),
    z.object({ command: z.literal('pause') }),
    z.object({ command: z.literal('stop') }),
    z.object({ command: z.literal('continue') }),
    z.object({ command: z.literal('prevChapter') }),
    z.object({ command: z.literal('nextChapter') }),
    z.object({ command: z.literal('prevSentence') }),
    z.object({ command: z.literal('nextSentence') }),
    z.object({ command: z.literal('jumpToChapter',), index: z.number() }),
    z.object({ command: z.literal('jumpToSentence'), index: z.number() }),
    z.object({ command: z.literal('voiceChanged'), voice: z.string() }),
    z.object({ command: z.literal('rateChanged'), rate: z.number() }),
    z.object({ command: z.literal('volumeChanged'), volume: z.number() }),
    z.object({ command: z.literal('engineModeChanged'), mode: z.enum(['local', 'neural']) }),
    z.object({ command: z.literal('loadDocument') }),
    z.object({ command: z.literal('loadAndPlay') }),
    z.object({ command: z.literal('resetContext') }),
    z.object({ command: z.literal('log'), message: z.string() }),
    z.object({ command: z.literal('sentenceEnded') })
]);

export type WebviewCommand = z.infer<typeof WebviewCommandSchema>;
