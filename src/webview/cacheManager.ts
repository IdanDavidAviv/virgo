import { CacheDelta } from '../common/types';

export class CacheManager {
    private static instance: CacheManager;
    private dbName = 'VirgoAudioCache';
    private storeName = 'audio-cache';
    private db: IDBDatabase | null = null;
    private _initPromise: Promise<IDBDatabase> | null = null;
    private _addedKeys: Set<string> = new Set();
    private _deletedKeys: Set<string> = new Set();
    private _onDelta: ((delta: CacheDelta) => void) | null = null;
    private _flushTimer: any = null;
    private _lastIntentId: number = 0;

    // [v2.2.1] Tier-1 Memory Cache (High-Fidelity / Low Latency)
    private _memoryCache: Map<string, { blob: Blob, timestamp: number }> = new Map();
    private readonly MAX_MEM_ENTRIES = 50;

    constructor() {
        // [SINGLETON] Access via getInstance()
    }

    /**
     * Wait for the database to be fully initialized.
     * Use this in bootstrap or test setup.
     */
    public async ready(): Promise<void> {
        await this.getDB();
    }

    public static getInstance(): CacheManager {
        if (!this.instance) {
            this.instance = new CacheManager();
        }
        return this.instance;
    }

    /** @internal for tests only */
    public static resetInstance(): void {
        this.instance = undefined as any;
    }

    public setOnDeltaListener(listener: (delta: CacheDelta) => void) {
        this._onDelta = listener;
    }

    private initDB(): Promise<IDBDatabase> {
        if (this._initPromise) {return this._initPromise;}

        this._initPromise = new Promise((resolve, reject) => {
            // [UPGRADE] Move to version 4 for schema stability and migration fix
            const request = indexedDB.open(this.dbName, 4);

            request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
                const db = (event.target as IDBOpenDBRequest).result;
                const oldVersion = event.oldVersion;

                if (oldVersion < 1) {
                    const store = db.createObjectStore(this.storeName);
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
                
                // [PHASE 4] Migration logic: Ensure index exists and schema is v4
                if (oldVersion > 0 && oldVersion < 4) {
                    console.log(`[CacheManager] 🔧 Migrating v${oldVersion} -> v4 (Atomic Refresh)`);
                    // Since we can't easily add an index to an existing store with data without a full 
                    // re-creation or complex migration, and this is still alpha-ish, we do a clean sweep.
                    try {
                        db.deleteObjectStore(this.storeName);
                    } catch (e) {}
                    const store = db.createObjectStore(this.storeName);
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };

            request.onsuccess = async (event: Event) => {
                this.db = (event.target as IDBOpenDBRequest).result;
                console.log('[CacheManager] 🚀 Database initialized (v4)');
                
                // [LIFECYCLE] Handle external closes or upgrades from other tabs
                this.db.onversionchange = () => {
                    this.db?.close();
                    this.db = null;
                    this._initPromise = null;
                };

                try {
                    await this._runGC(); // Run GC on boot
                    await this.syncFullManifest();
                } catch (e) {
                    console.error('[CacheManager] Initialization tasks failed:', e);
                }
                resolve(this.db!);
            };

            request.onerror = (event: Event) => {
                const error = (event.target as IDBOpenDBRequest).error;
                console.error('[CacheManager] ❌ IndexedDB error:', error);
                
                // [RESILIENCE] Nuclear fallback: If DB is corrupted or upgrade blocked, wipe it.
                if (error?.name === 'VersionError' || error?.name === 'UnknownError') {
                    console.warn('[CacheManager] ⚠️ Database corrupted. Re-initializing...');
                    indexedDB.deleteDatabase(this.dbName);
                }
                
                this._initPromise = null;
                reject(error);
            };
        });
        return this._initPromise!;
    }

    /**
     * Closes the database connection and resets initialization state.
     */
    public async close(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this._initPromise = null;
    }

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) {
            return this.db;
        }
        return this.initDB();
    }

    /**
     * Retrieves an audio blob from the cache.
     * [v2.2.1] Tier-1 (Memory) -> Tier-2 (IndexedDB)
     * @param key The cache key
     */
    public async get(key: string): Promise<Blob | null> {
        // 1. Tier-1 Memory Hit
        const memEntry = this._memoryCache.get(key);
        if (memEntry) {
            console.log(`[CacheManager] 🧠 Tier-1 Memory Hit: ${key}`);
            // [v2.2.1] Update timestamp for LRU
            memEntry.timestamp = Date.now();
            return memEntry.blob;
        }

        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.storeName, 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.get(key);

                request.onsuccess = () => {
                    const result = request.result;
                    if (!result) {
                        resolve(null);
                        return;
                    }

                    let blob: Blob | null = null;
                    if (result instanceof Blob) {
                        blob = result;
                    } else if (result && result.data instanceof Blob) {
                        blob = result.data;
                    } else if (result && result.data) {
                        // Support for specific environments (e.g., tests/older webviews)
                        blob = result.data;
                    }

                    if (blob) {
                        console.log(`[CacheManager] 📀 Tier-2 Disk Hit (Hydrating Memory): ${key}`);
                        this._memoryCache.set(key, { blob, timestamp: Date.now() });
                        this._pruneMemory();
                        resolve(blob);
                    } else {
                        console.warn(`[CacheManager] ⚠️ Invalid cache entry format for ${key}:`, result);
                        resolve(null);
                    }
                };
                request.onerror = () => {
                    console.error(`[CacheManager] ❌ Read Error for ${key}:`, request.error);
                    reject(request.error);
                };
            });
        } catch (e) {
            console.error(`[CacheManager] ❌ get() failed for ${key}:`, e);
            return null;
        }
    }

    /**
     * Saves an audio blob to the cache (Both tiers).
     */
    public async set(key: string, blob: Blob, intentId?: number): Promise<void> {
        // [v2.2.1] Update Memory Tier
        this._memoryCache.set(key, { blob, timestamp: Date.now() });
        this._pruneMemory();

        if (intentId !== undefined) {
            this._lastIntentId = intentId;
        }

        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.storeName, 'readwrite');
                const store = transaction.objectStore(this.storeName);
                
                // [SCHEMA v3] Store with timestamp for LRU/TTL and explicit size for GC stability
                const request = store.put({
                    data: blob,
                    timestamp: Date.now(),
                    size: blob.size || 0
                }, key);

                request.onsuccess = () => {
                    this._addedKeys.add(key);
                    this._deletedKeys.delete(key);
                    this._triggerFlush();
                    resolve();
                };
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('CacheManager.set failed:', e);
        }
    }

    private _pruneMemory(): void {
        if (this._memoryCache.size <= this.MAX_MEM_ENTRIES) {return;}
        
        const sorted = Array.from(this._memoryCache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        
        while (this._memoryCache.size > this.MAX_MEM_ENTRIES) {
            const entry = sorted.shift();
            if (entry) {this._memoryCache.delete(entry[0]);}
        }
    }

    private _triggerFlush() {
        if (this._flushTimer) {clearTimeout(this._flushTimer);}
        this._flushTimer = setTimeout(() => this.flushDeltas(), 500);
    }

    /**
     * [v2.3.1] Synchronous Tier-1 check.
     * Required for fast predictive synthesis logic.
     */
    public isCachedLocally(key: string): boolean {
        return this._memoryCache.has(key);
    }

    /**
     * Checks if a key exists in the cache (Async lookup).
     */
    public async exists(key: string): Promise<boolean> {
        const item = await this.get(key);
        return item !== null;
    }

    /**
     * Clears the entire audio cache (Both tiers).
     */
    public async clearAll(): Promise<void> {
        this._memoryCache.clear();
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.storeName, 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.clear();

                request.onsuccess = () => {
                    console.log('Audio cache cleared successfully.');
                    this.syncFullManifest(); // Reset manifest state
                    resolve();
                };
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('CacheManager.clearAll failed:', e);
        }
    }

    /**
     * [v2.0.6] Returns metadata for the entire cache (Atomic Monitoring).
     */
    public async getStats(): Promise<{ count: number, size: number }> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.storeName, 'readonly');
                const store = transaction.objectStore(this.storeName);
                
                const countReq = store.count();
                const cursorReq = store.openCursor();
                
                let size = 0;
                let countReady = false;
                let cursorReady = false;

                const checkFinished = () => {
                    if (countReady && cursorReady) {
                        resolve({ count: countReq.result || 0, size });
                    }
                };

                countReq.onsuccess = () => {
                    countReady = true;
                    checkFinished();
                };

                cursorReq.onsuccess = () => {
                    const cursor = cursorReq.result;
                    if (cursor) {
                        const val = cursor.value;
                        // Use explicit size if provided, fallback to blob
                        const itemSize = (typeof val.size === 'number') ? val.size :
                                         (val instanceof Blob ? val.size : 
                                         (val.data instanceof Blob ? val.data.size : 0));
                        size += itemSize;
                        cursor.continue();
                    } else {
                        cursorReady = true;
                        checkFinished();
                    }
                };

                transaction.onerror = () => reject(transaction.error);
                cursorReq.onerror = () => reject(cursorReq.error);
            });
        } catch (e) {
            console.error('CacheManager.getStats failed:', e);
            return { count: 0, size: 0 };
        }
    }

    /**
     * [SOVEREIGNTY] Sends the full set of keys to the extension host.
     * Called on initialization to ground the extension's manifest.
     */
    public async syncFullManifest() {
        try {
            const db = await this.getDB();
            const transaction = db.transaction(this.storeName, 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.getAllKeys();

            request.onsuccess = () => {
                const keys = (request.result as string[]) || [];
                console.log(`[CacheManager] 📡 Syncing Full Manifest (${keys.length} keys)`);
                
                if (this._onDelta) {
                    this._onDelta({
                        added: keys,
                        removed: [],
                        isFullSync: true,
                        playbackIntentId: this._lastIntentId || 0
                    });
                } else {
                    console.warn('[CacheManager] ⚠️ No delta listener attached. Manifest sync deferred.');
                }
            };
        } catch (e) {
            console.error('[CacheManager] Full manifest sync failed:', e);
        }
    }

    /**
     * [PHASE 4] Lifecycle Management: 7-day TTL and 100MB Cap.
     */
    private async _runGC() {
        try {
            const db = await this.getDB();
            const TTL = 7 * 24 * 60 * 60 * 1000; // 7 Days
            const SIZE_LIMIT = 100 * 1024 * 1024; // 100MB
            const TARGET_SIZE = 80 * 1024 * 1024; // 80MB (Low Watermark)
            const now = Date.now();
            
            console.log('[CacheManager] 🧹 Starting GC sweep...');

            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            // Ensure index exists (V4 Migration check)
            try {
                store.index('timestamp');
            } catch (e) {
                console.warn('[CacheManager] ⚠️ Timestamp index missing in GC. This should not happen in v4.');
            }
            
            let totalSize = 0;
            const entries: { key: string, size: number, timestamp: number }[] = [];

            // 1. Scan and Gather Metadata
            return new Promise<void>((resolve, reject) => {
                const cursorReq = store.openCursor();
                cursorReq.onsuccess = () => {
                    const cursor = cursorReq.result;
                    if (cursor) {
                        const val = cursor.value;
                        const data = val.data || val;
                        
                        // [v2.2.1] Standardized size detection
                        const size = (typeof val.size === 'number') ? val.size : 
                                     ((data && typeof data.size === 'number') ? data.size : 0);
                        
                        const key = cursor.key.toString();
                        const timestamp = val.timestamp || 0;
                        
                        if (size === 0 && (val.data || val instanceof Blob)) {
                            console.warn(`[CacheManager] 🔍 GC Warning: Item ${key} has 0 size. Keys: ${Object.keys(val).join(',')}`);
                        }
                        
                        // console.log(`[CacheManager] 🔍 GC Scan: ${key} | Size: ${Math.round(size/1024)}KB | TS: ${timestamp}`);

                        // 1. Immediate TTL Pruning (7 Days)
                        if (timestamp < now - TTL) {
                            console.log(`[CacheManager] 🗑️ GC: TTL Expired: ${key}`);
                            store.delete(key);
                            this._memoryCache.delete(key);
                            this._deletedKeys.add(key);
                        } else {
                            totalSize += size;
                            entries.push({ key, size, timestamp });
                        }
                        cursor.continue();
                    } else {
                        // 2. Size Cap Pruning (High Watermark -> Low Watermark)
                        if (totalSize > SIZE_LIMIT) {
                            console.warn(`[CacheManager] ⚖️ Cache Overlimit: ${Math.round(totalSize/1024/1024)}MB. Trimming...`);
                            
                            entries.sort((a, b) => a.timestamp - b.timestamp);
                            
                            for (const entry of entries) {
                                if (totalSize <= TARGET_SIZE) {break;}
                                
                                console.log(`[CacheManager] 🗑️ GC Pruning: ${entry.key}`);
                                store.delete(entry.key);
                                this._memoryCache.delete(entry.key);
                                this._deletedKeys.add(entry.key);
                                totalSize -= entry.size;
                            }
                        }
                        
                        console.log(`[CacheManager] ✅ GC Finished. Total Items: ${entries.length} | Final Size: ${Math.round(totalSize/1024/1024)}MB`);
                        this._triggerFlush();
                        resolve();
                    }
                };
                cursorReq.onerror = () => reject(cursorReq.error);
            });
        } catch (e) {
            console.error('[CacheManager] GC Failed:', e);
            if (e instanceof Error) {
                console.error(`[CacheManager] GC Error Stack: ${e.stack}`);
            } else {
                console.error(`[CacheManager] GC Error Detail: ${JSON.stringify(e)}`);
            }
        }
    }

    /**
     * [SOVEREIGNTY] Sends only the changes since the last sync.
     */
    public flushDeltas() {
        if (this._addedKeys.size === 0 && this._deletedKeys.size === 0) {return;}

        const added = Array.from(this._addedKeys);
        const removed = Array.from(this._deletedKeys);

        console.log(`[CacheManager] 📡 Flushing Delta (A:${added.length}, R:${removed.length})`);
        
        if (this._onDelta) {
            this._onDelta({
                added,
                removed,
                isFullSync: false,
                playbackIntentId: this._lastIntentId || 0
            });
        }

        this._addedKeys.clear();
        this._deletedKeys.clear();
    }
}
