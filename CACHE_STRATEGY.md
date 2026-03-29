# Voice Cache Strategy

To optimize the voice selection process and prevent Azure TTS server exhaustion, we implement a voice-aware, multi-tiered caching mechanism.

## Core Problem
Currently, changing the voice triggers a full cache reset (`clearCache()`). This results in re-fetching every sentence from Azure when Switching voices, leading to:
1. High latency (25s+ timeouts).
2. Redundant API costs/usage.
3. Server saturation during prefetching.

## Proposed Strategy

### 1. Voice-Aware Cache Keying
Instead of a text-only hash, the cache key must be a composite of the document context and the voice parameters:
- **Formula**: `voiceId` + `rate` + `textHash` (or `docId:chapter:sentence`)
- **Benefit**: Switching back to a previously used voice will result in immediate cache hits.

### 2. Selective Cache Invalidation
Stop calling `clearCache()` on voice changes.
- **Persistence**: Retain cached segments for multiple voices.
- **Eviction**: Use the existing 50MB LRU policy to manage memory. Older or less-used voices will naturally be purged without wiping the session's active progress.

### 3. Azure Pressure Mitigation
- **Throttled Prefetching**: Limit prefetch concurrency to avoid saturating the network.
- **Priority Synthesis**: User-initiated playback always interrupts background prefetching.

## Implementation Details
- **Tiers**:
  - **Tier 1**: Memory Cache (Map) for per-session speed.
  - **Tier 2**: `vscode.globalState` for cross-session voice metadata (Neural Voice List).
- **Invalidation Triggers**:
  - Extension version updates.
  - Manual "Clear Audio Cache" command.
  - 24-hour expiration for voice list metadata.
