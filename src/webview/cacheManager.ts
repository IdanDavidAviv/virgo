/// <reference lib="dom" />

/**
 * CacheManager: Handles persistent audio blob storage in the webview using IndexedDB.
 * This ensures audio remains available across VS Code restarts.
 */
export class CacheManager {
    private dbName = 'ReadAloudAudioCache';
    private storeName = 'audioBlobs';
    private db: IDBDatabase | null = null;

    constructor() {
        this.initDB();
    }

    private initDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };

            request.onsuccess = (event: Event) => {
                this.db = (event.target as IDBOpenDBRequest).result;
                resolve(this.db!);
            };

            request.onerror = (event: Event) => {
                console.error('IndexedDB error:', (event.target as IDBOpenDBRequest).error);
                reject((event.target as IDBOpenDBRequest).error);
            };
        });
    }

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) {
            return this.db;
        }
        return this.initDB();
    }

    /**
     * Retrieves an audio blob from the cache.
     * @param key The cache key (voice-docId-salt-chapter-sentence)
     */
    public async get(key: string): Promise<Blob | null> {
        console.log(`[CacheManager] 🔍 Reading: ${key}`);
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.storeName, 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.get(key);

                request.onsuccess = () => {
                    const result = request.result || null;
                    console.log(`[CacheManager] 📀 Read Result: ${result ? 'Hit' : 'Miss'} for ${key}`);
                    resolve(result);
                };
                request.onerror = () => {
                    console.error(`[CacheManager] ❌ Read Error for ${key}:`, request.error);
                    reject(request.error);
                };
            });
        } catch (e) {
            console.error('CacheManager.get failed:', e);
            return null;
        }
    }

    /**
     * Saves an audio blob to the cache.
     */
    public async set(key: string, blob: Blob): Promise<void> {
        console.log(`[CacheManager] 💾 Writing: ${key} (${blob.size} bytes)`);
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.storeName, 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.put(blob, key);

                request.onsuccess = () => {
                    console.log(`[CacheManager] ✅ Write Success: ${key}`);
                    resolve();
                };
                request.onerror = () => {
                    console.error(`[CacheManager] ❌ Write Error for ${key}:`, request.error);
                    reject(request.error);
                };
            });
        } catch (e) {
            console.error('CacheManager.set failed:', e);
        }
    }

    /**
     * Checks if a key exists in the cache.
     */
    public async exists(key: string): Promise<boolean> {
        const item = await this.get(key);
        return item !== null;
    }

    /**
     * Clears the entire audio cache.
     */
    public async clearAll(): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.storeName, 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.clear();

                request.onsuccess = () => {
                    console.log('Audio cache cleared successfully.');
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

                cursorReq.onsuccess = (event) => {
                    const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
                    if (cursor) {
                        if (cursor.value instanceof Blob) {
                            size += cursor.value.size;
                        }
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
}
