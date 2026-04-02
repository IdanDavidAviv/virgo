import { CacheManager } from './cacheManager';
import { reconcilePlaybackUI } from './uiManager';
import { MessageClient } from './core/messageClient';
import { WebviewStore } from './core/WebviewStore';
import { OutgoingAction } from '../common/types';


(function () {
    window.onerror = function (msg, url, line, col) {
        const errorDetail = `[DASHBOARD] CRITICAL ERROR: ${msg} at line ${line}:${col}`;
        console.error(errorDetail);
        if (window.vscode) {
            try { window.vscode.postMessage({ command: 'error', message: errorDetail }); } catch (e) { }
        }
    };

    // --- High-Integrity Infrastructure (Phase 5.1 & 5.2) ---
    const client = MessageClient.getInstance();
    const store = WebviewStore.getInstance();

    // Verification Probe: Reactive logging for state synchronization
    store.subscribe((state) => state.isPlaying, (isPlaying) => {
        console.log(`%c[WebviewStore] State Sync -> isPlaying: ${isPlaying}`, 'color: #00ff00; background: #222; padding: 2px 5px; border-radius: 4px;');
    });

    const vscode = window.vscode;
    
    // --- State (MINIMAL LIFESTYLE) ---
    // We only keep state that is not provided by UI_SYNC or is strictly local UI preference.
    let lastSyncPacket = null; 
    let isDraggingSlider = false;
    let currentReadingUri = '';
    let currentChapterIndex = -1;
    let currentSentenceIndex = -1;
    let currentTotalSentences = 0;
    
    // UI state
    let chapters = [];
    let collapsedIndices = new Set();
    let lastHighlightedLine = -1;
    let navDebounceTimer = null;
    let sentenceNavigatorController = null;
    let pendingChapterIndex = -1;
    let pendingChapterTimer = null;
    
    let currentAudioUrl = null;
    let activeObjectURLs = new Set();
    
    // --- Controller ---
    let readAloudController = null;
    
    // --- Persistence ---
    const cache = new CacheManager();


    // --- Components ---
    class SentenceNavigator {
        constructor(elements, options) {
            this.els = elements; // { navigator, prev, current, next }
            this.options = options; // { onJump }
            this.state = {
                sentences: [],
                currentIndex: -1,
                isStalled: false,
                pendingIndex: -1,
                pendingTimer: null
            };
        }

        update(sentences, currentIndex, isStalled) {
            // Ignore stale syncs if we have an active pending jump
            if (this.state.pendingIndex !== -1 && currentIndex !== this.state.pendingIndex) {
                return;
            }

            this.state.pendingIndex = -1;
            if (this.state.pendingTimer) {
                clearTimeout(this.state.pendingTimer);
                this.state.pendingTimer = null;
            }

            this.state.sentences = sentences;
            this.state.currentIndex = currentIndex;
            this.state.isStalled = isStalled;
            this.render();
        }

        jump(index) {
            if (index < 0 || index >= this.state.sentences.length) {return;}
            
            this.state.pendingIndex = index;
            this.render(); // Immediate feedback
            this.options.onJump(index);

            // Safety fallback: if extension doesn't confirm in 1s, snap back to reality
            if (this.state.pendingTimer) {clearTimeout(this.state.pendingTimer);}
            this.state.pendingTimer = setTimeout(() => {
                if (this.state.pendingIndex !== -1) {
                    this.state.pendingIndex = -1;
                    this.render();
                }
            }, 1000);
        }

        render() {
            const displayIndex = this.state.pendingIndex !== -1 ? this.state.pendingIndex : this.state.currentIndex;
            const sentences = this.state.sentences;
            
            this.els.navigator.classList.toggle('stalled', this.state.isStalled);

            const prevIdx = displayIndex - 1;
            const nextIdx = displayIndex + 1;

            this._renderRow(this.els.prev, prevIdx >= 0 ? sentences[prevIdx] : '', prevIdx);
            this._renderRow(this.els.current, displayIndex >= 0 ? sentences[displayIndex] : '', displayIndex, true);
            this._renderRow(this.els.next, nextIdx < sentences.length ? sentences[nextIdx] : '', nextIdx);
        }

        _renderRow(el, text, idx, isCurrent = false) {
            if (!el) {return;}
            el.style.display = 'flex';
            
            if (!text) {
                el.innerHTML = '<span class="sentence-placeholder">&nbsp;</span>';
                el.onclick = null;
                el.style.pointerEvents = 'none';
                el.style.opacity = '0';
                return;
            }

            el.style.pointerEvents = 'auto';
            el.style.opacity = isCurrent ? '1' : '0.15';
            el.classList.toggle('current', isCurrent);
            el.classList.toggle('stalled', isCurrent && this.state.isStalled);
            
            // RTL Detection
            const isHebrew = /[\u0590-\u05FF]/.test(text);
            el.classList.toggle('rtl', isHebrew);

            el.innerHTML = `<span>${renderWithLinks(text)}</span>`;

            if (idx !== null && !isCurrent) {
                el.onclick = () => this.jump(idx);
            } else {
                el.onclick = null;
            }
        }
    }

    // --- DOM References ---
    let activeSlot, readerSlot, activeFilename, activeDir, readerFilename, readerDir, btnLoadFile;
    let voiceSelect, statusDot, chapterList, chapterProgress, btnPrev, btnNext, btnAutoplay;
    let settingsToggle, settingsDrawer, rateSlider, rateVal, volumeSlider, volumeVal;
    let btnPlay, btnPause, btnStop, sentenceNavigator, sentencePrev, sentenceCurrent, sentenceNext;
    let btnPrevSentence, btnNextSentence, engineLocal, engineNeural, engineToggleGroup;
    let neuralPlayer, voiceSearch, toastContainer, engineStatusTag, cacheDebugTag, waveContainer;

    function getEl(id) {
        const el = document.getElementById(id);
        if (!el) { console.warn(`[DOM] Missing expected element: #${id}`); }
        return el;
    }

    function syncAudioUI() {
        const rate = lastSyncPacket?.rate ?? 0;
        const volume = lastSyncPacket?.volume ?? 50;

        if (rateSlider) {
            rateSlider.value = rate;
            if (rateVal) { rateVal.textContent = (rate > 0 ? '+' : '') + rate; }
        }
        if (volumeSlider) {
            volumeSlider.value = volume;
            if (volumeVal) { volumeVal.textContent = volume + '%'; }
        }
        if (neuralPlayer) {
            neuralPlayer.volume = volume / 100;
            neuralPlayer.playbackRate = rate >= 0 ? 1 + (rate / 10) : 1 + (rate / 20);
        }
    }

    try {
        activeSlot = document.querySelector('.context-slot.selection');
        readerSlot = document.querySelector('.context-slot.reader');
        activeFilename = getEl('active-filename');
        activeDir = getEl('active-dir');
        readerFilename = getEl('reader-filename');
        readerDir = getEl('reader-dir');
        btnLoadFile = getEl('btn-load-file');
        
        voiceSelect = getEl('voice-select');
        statusDot = getEl('status-dot');
        chapterList = getEl('chapter-list');
        chapterProgress = getEl('chapter-progress');
        btnPrev = getEl('btn-prev');
        btnNext = getEl('btn-next');
        btnAutoplay = getEl('btn-autoplay');

        settingsToggle = getEl('settings-toggle');
        settingsDrawer = getEl('settings-drawer');
        rateSlider = getEl('rate-slider');
        rateVal = getEl('rate-val');
        volumeSlider = getEl('volume-slider');
        volumeVal = getEl('volume-val');
        btnPlay = getEl('btn-play');
        btnPause = getEl('btn-pause');
        btnStop = getEl('btn-stop');
        sentenceNavigator = getEl('sentence-navigator');
        sentencePrev = getEl('sentence-prev');
        sentenceCurrent = getEl('sentence-current');
        sentenceNext = getEl('sentence-next');
        btnPrevSentence = getEl('btn-prev-sentence');
        btnNextSentence = getEl('btn-next-sentence');
        engineLocal = getEl('engine-local');
        engineNeural = getEl('engine-neural');
        engineToggleGroup = document.querySelector('.engine-toggle-group');
        neuralPlayer = getEl('neural-player');
        voiceSearch = getEl('voice-search');
        toastContainer = getEl('toast-container');
        engineStatusTag = getEl('status-dot');
        cacheDebugTag = getEl('cache-debug-tag');
        waveContainer = getEl('sentence-navigator');

        // Initialize Components
        readAloudController = new PlaybackController(vscode, neuralPlayer);

        sentenceNavigatorController = new SentenceNavigator({
            navigator: sentenceNavigator,
            prev: sentencePrev,
            current: sentenceCurrent,
            next: sentenceNext
        }, {
            onJump: (idx) => debouncedPostMsg({ command: 'jumpToSentence', index: idx })
        });

        console.log('[DASHBOARD] DOM Selection complete.');

        // Manual Cache Clear
        if (cacheDebugTag) {
            cacheDebugTag.onclick = async () => {
                const confirmed = confirm('Clear all cached neural audio?');
                if (confirmed) {
                    await cache.clearAll();
                    showToast('Audio cache cleared', 'info');
                    cacheDebugTag.classList.add('pulse');
                    setTimeout(() => cacheDebugTag.classList.remove('pulse'), 500);
                }
            };
        }
        
        // Initial UI Sync from persisted state
        syncAudioUI();

        // Debug Mode Indicator (Serverless Handshake)
        const config = window.__BOOTSTRAP_CONFIG__;
        if (config && config.debugMode) {
            const debugTag = document.getElementById('debug-mode-tag');
            if (debugTag) {
                debugTag.style.display = 'inline-block';
            }
        }
    } catch (e) {
        console.error('[DASHBOARD] DOM Selection failed:', e);
    }

    // (Remnants moved to top for hoisting safety)


    // --- Chapter Rendering ---
    function renderChapters(chapterData, currentIdx) {
        if (!chapterList) { return; }
        chapters = chapterData;
        chapterList.innerHTML = '';

        if (!chapters || chapters.length === 0) {
            chapterList.innerHTML = '<div class="chapter-placeholder">No headings found.</div>';
            return;
        }

        // Trace hidden state: if a parent is collapsed, all items with greater level are hidden 
        // until we meet an item with equal or lower level than the parent.
        let hideLevelAt = Infinity;

        chapters.forEach((ch, i) => {
            // If we hit an item at the same or shallower level as the current hidden constraint, stop hiding.
            if (ch.level <= hideLevelAt) {
                hideLevelAt = Infinity;
            }

            const item = document.createElement('div');
            item.className = 'chapter-item level-' + ch.level;
            item.dataset.index = i;
            if (i === currentIdx) { item.classList.add('now-playing'); }
            
            const isParent = (i < chapters.length - 1 && chapters[i + 1].level > ch.level);
            
            if (isParent && collapsedIndices.has(i)) {
                item.classList.add('collapsed');
                if (hideLevelAt === Infinity) { hideLevelAt = ch.level; }
            }

            if (ch.level > hideLevelAt) {
                item.classList.add('is-hidden');
            }

            const chevronIcon = isParent ? '▼' : '';
            const rowCount = ch.count || 0;
            const isEmpty = rowCount === 0;

            if (isEmpty) { item.classList.add('empty'); }
            if (i === pendingChapterIndex) { item.classList.add('pending'); }

            item.innerHTML = `
                <span class="chevron">${chevronIcon}</span>
                <span class="chapter-title">${escapeHtml(ch.title)}</span>
                <span class="chapter-row-count">${rowCount} rows</span>
                <span class="chapter-play-icon">▶</span>
            `;

            // Click Logic: Chevron ONLY toggles; Row selection ONLY plays
            item.onclick = (e) => {
                if (isEmpty) { return; }
                if (e.target.classList.contains('chevron')) {
                    if (isParent) { toggleCollapse(i); }
                    return;
                }
                
                // --- INSTANT VISUAL FEEDBACK (Chapter) ---
                pendingChapterIndex = i;
                syncPlaybackUI(i, 0, rowCount);

                // --- DEBOUNCED COMMAND ---
                debouncedPostMsg({ command: 'jumpToChapter', index: i });

                // Safety fallback
                if (pendingChapterTimer) { clearTimeout(pendingChapterTimer); }
                pendingChapterTimer = setTimeout(() => {
                    if (pendingChapterIndex === i) {
                        pendingChapterIndex = -1;
                        syncPlaybackUI();
                    }
                }, 1000);
            };

            chapterList.appendChild(item);
        });

        syncPlaybackUI(currentIdx, 0, chapters[currentIdx]?.count || 0);
    }

    function toggleCollapse(index) {
        if (collapsedIndices.has(index)) {
            collapsedIndices.delete(index);
        } else {
            collapsedIndices.add(index);
        }
        renderChapters(chapters, currentChapterIndex);
        syncPlaybackUI();
    }

    function syncPlaybackUI(chapterIndex, sentenceIndex, totalSentences) {
        // 1. Update internal tracking if provided
        if (chapterIndex !== undefined) { 
            currentChapterIndex = chapterIndex; 
            if (chapterIndex === pendingChapterIndex) {
               pendingChapterIndex = -1;
               if (pendingChapterTimer) { clearTimeout(pendingChapterTimer); pendingChapterTimer = null; }
            }
        }
        if (sentenceIndex !== undefined) { currentSentenceIndex = sentenceIndex; }
        if (totalSentences !== undefined) { currentTotalSentences = totalSentences; }

        // 2. Update Progress Header (Title Bar)
        if (!chapterProgress || chapters.length === 0) {
            chapterProgress.innerHTML = '—';
        } else {
            const chStr = `${currentChapterIndex + 1} / ${chapters.length}`;
            const rowStr = currentTotalSentences ? `<span style="opacity: 0.5; margin: 0 8px;">•</span><span style="font-weight: 400; opacity: 0.8;">ROW ${currentSentenceIndex + 1} / ${currentTotalSentences}</span>` : '';
            chapterProgress.innerHTML = `${chStr}${rowStr}`;
        }

        // 3. Update Chapter List Highlights
        const allItems = chapterList ? chapterList.querySelectorAll('.chapter-item') : [];
        const progressPercentage = currentTotalSentences > 0 ? (currentSentenceIndex / (currentTotalSentences - 1)) * 100 : 0;

        allItems.forEach((el) => {
            const idx = parseInt(el.dataset.index);
            const isNowPlaying = idx === currentChapterIndex;
            const isPending = idx === pendingChapterIndex;

            el.classList.toggle('now-playing', isNowPlaying);
            el.classList.toggle('pending', isPending);

            if (isNowPlaying) {
                el.style.setProperty('--chapter-progress', `${progressPercentage}%`);
            } else {
                el.style.removeProperty('--chapter-progress');
            }
        });

        // 4. Managed Scrolling (Smart)
        const activeIdx = (pendingChapterIndex !== -1) ? pendingChapterIndex : currentChapterIndex;
        const activeEl = chapterList && chapterList.querySelector(`.chapter-item[data-index="${activeIdx}"]`);
        if (activeEl) {
            const rect = activeEl.getBoundingClientRect();
            const containerRect = chapterList.getBoundingClientRect();
            const isVisible = (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom);
            
            if (!isVisible) {
                activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }

    function escapeHtml(str) {
        if (!str) { return ''; }
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * Authoritative UI reconciler - uses UIManager for consistency and testing.
     */
    function updatePlaybackUI(state) {
        const elements = { btnPlay, btnPause, waveContainer };
        reconcilePlaybackUI(state, elements, readAloudController);
    }


    function renderWithLinks(text) {
        if (!text) { return ''; }
        const html = escapeHtml(text);
        // Find [label](file:///...) and convert to <a>
        return html.replace(/\[([^\]]+)\]\((file:\/\/\/[^\s)]+)\)/g, (match, label, uri) => {
            return `<a class="file-link" data-uri="${uri}" title="Open in Editor">${label}</a>`;
        });
    }

    function base64ToBlob(base64, mime) {
        const sliceSize = 1024;
        const byteCharacters = atob(base64);
        const byteArrays = [];
        for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
            const slice = byteCharacters.slice(offset, offset + sliceSize);
            const byteNumbers = new Array(slice.length);
            for (let i = 0; i < slice.length; i++) {
                byteNumbers[i] = slice.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            byteArrays.push(byteArray);
        }
        return new Blob(byteArrays, { type: mime });
    }

    // --- Loading UI Helpers [DEPRECATED] ---
    // (Replaced by PlaybackController + reconcilePlaybackUI)

    // --- Context Parsing ---
    function updateContextSlot(uri, filenameEl, dirEl, version, precalcName, precalcDir) {
        if (!uri) {
            filenameEl.textContent = filenameEl.id === 'reader-filename' ? 'No File Loaded' : 'No Selection';
            dirEl.textContent = '';
            return;
        }

        const filename = precalcName || uri.split(/[\\\/]/).pop() || '';
        const dir = precalcDir !== undefined ? precalcDir : (uri.split(/[\\\/]/).length > 3 ? uri.split(/[\\\/]/).slice(-3).join('/') : '');

        // Show both explicit 'V' versions and 'T' timestamps as badges.
        const versionHtml = version ? `<span class="version-badge">${version}</span>` : '';
        filenameEl.innerHTML = `${escapeHtml(filename)}${versionHtml}`;
        dirEl.textContent = dir ? `${dir} /` : '';
    }

    // --- Toast Notifications ---
    function showToast(message, type = 'info') {
        if (!toastContainer) { return; }
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        let icon = 'ℹ️';
        if (type === 'error') { icon = '❌'; }
        if (type === 'warning') { icon = '⚠️'; }
        
        toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
        toastContainer.appendChild(toast);

        // Auto-remove after 4s
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    // --- Sentence Navigator ---
    // --- DELETED updateSentenceNavigator and updateRow (Moved to Class) ---

    function logSafeMessage(msg) {
        const command = msg.command;
        if (command === 'state-sync' || command === 'cacheStatus' || command === 'progress') { return; }

        const sanitize = (val) => {
            if (val === null || val === undefined) { return val; }
            if (Array.isArray(val)) { return val.length > 5 ? `[CNT:${val.length}]` : val.map(sanitize); }
            if (typeof val === 'string') {
                if (val.length > 1000) { return `[BIN:${Math.round(val.length/1024)}KB]`; }
                if (val.includes('file:///')) { return val.split(/[\\\/]/).pop(); } // Minimal path
                return val.length > 64 ? val.substring(0, 61) + '...' : val;
            }
            if (typeof val === 'object') {
                const s = {};
                for (let k in val) {
                    s[k] = sanitize(val[k]);
                }
                return s;
            }
            return val;
        };

        const payload = Object.entries(msg)
            .filter(([k]) => k !== 'command')
            .map(([k, v]) => `${k}:${typeof v === 'object' ? JSON.stringify(sanitize(v)) : sanitize(v)}`)
            .join(' | ');

        console.log(`[EXTENSION -> DASHBOARD] [${command.toUpperCase()}] ${payload}`);
    }

    function updateStateDebug(packet) {
        const tag = document.getElementById('state-debug-tag');
        if (!tag) {
            return;
        }
        
        const vol = packet.volume;
        const rate = packet.rate;
        
        // Normalize rate display to match slider (0 is 1.0x)
        const displayRate = (1 + (rate / 10)).toFixed(1);
        
        tag.textContent = `[ V:${vol} | R:${displayRate}x ]`;
    }

    // --- Message Handler ---
    async function handleCommand(message) {
        logSafeMessage(message);
        switch (message.command) {
            case 'UI_SYNC':
                // 1. Context Slots, Chapters & Progress
                const chaptersChanged = !lastSyncPacket || 
                    JSON.stringify(lastSyncPacket.allChapters) !== JSON.stringify(message.allChapters) ||
                    lastSyncPacket.state.currentChapterIndex !== message.state.currentChapterIndex;

                updateContextSlot(message.state.focusedDocumentUri, activeFilename, activeDir, message.state.focusedVersionSalt, message.state.focusedFileName, message.state.focusedRelativeDir);
                updateContextSlot(message.state.activeDocumentUri, readerFilename, readerDir, message.state.versionSalt, message.state.activeFileName, message.state.activeRelativeDir);
                
                if (chaptersChanged) {
                    renderChapters(message.allChapters || [], message.state.currentChapterIndex);
                }
                
                // 2. Sentence Navigator
                if (message.currentSentences) {
                    sentenceNavigatorController.update(message.currentSentences, message.state.currentSentenceIndex, message.playbackStalled);
                }
                syncPlaybackUI(message.state.currentChapterIndex, message.state.currentSentenceIndex, message.currentSentences?.length || 0);
                
                // 2. Playback Logic (Refactored)
                readAloudController.handleSync(message);
                updatePlaybackUI(message);


                // 3. Telemetry, Config & Indicators
                updateAutoPlayModeUI(message.autoPlayMode);
                updateStateDebug(message);
                
                // Audio UI [PHASE 4 Consolidation]
                syncAudioUI(message.rate, message.volume);
                
                // Voices Logic [PHASE 4]
                if (message.availableVoices) {
                    const activeEngine = message.engineMode || message.state.engineMode;
                    const listToRender = (activeEngine === 'neural') ? message.availableVoices.neural : message.availableVoices.local;
                    const selectedVoice = message.selectedVoice || message.state.selectedVoice;
                    renderVoiceList(listToRender, selectedVoice, activeEngine);
                }

                if (engineStatusTag) {
                    const isOnline = message.isPlaying && !message.isPaused;
                    engineStatusTag.classList.toggle('online', isOnline);
                    engineStatusTag.classList.toggle('stalled', !!message.playbackStalled);
                    engineStatusTag.classList.remove('fallback');
                }

                if (cacheDebugTag) {
                    const mb = (message.cacheSizeBytes / (1024 * 1024)).toFixed(1);
                    cacheDebugTag.textContent = `[ CACHE: ${message.cacheCount}/100 | ${mb}MB ]`;
                }

                if (btnLoadFile) {
                    const isMismatch = (message.state.activeDocumentUri !== message.state.focusedDocumentUri) && message.state.focusedIsSupported;
                    btnLoadFile.classList.toggle('mismatch', !!isMismatch);
                    btnLoadFile.disabled = !message.state.focusedIsSupported;
                }

                // Finalize Sync: Store current state as last packet for future comparison
                lastSyncPacket = message;
                currentReadingUri = message.state.activeDocumentUri;
                break;

            case 'voices':
                const list = (message.engineMode === 'neural') ? message.neuralVoices : message.voices;
                renderVoiceList(list, message.selectedVoice || lastSyncPacket?.state?.selectedVoice, message.engineMode);
                break;

            case 'playAudio':
                readAloudController.releaseLock();
                // Zombie Guard: If user stopped while we were synthesizing, ignore the audio.
                if (readAloudController.getState().intent === 'STOPPED') {
                    console.log('[DASHBOARD] Ignoring Zombie Audio (Intent was STOPPED)');
                    return;
                }

                if (neuralPlayer) {
                    const cacheKey = message.cacheKey;
                    
                    const handleBuffer = async (blob) => {
                        if (currentAudioUrl) {
                            URL.revokeObjectURL(currentAudioUrl);
                            activeObjectURLs.delete(currentAudioUrl);
                        }
                        currentAudioUrl = URL.createObjectURL(blob);
                        activeObjectURLs.add(currentAudioUrl);
                        neuralPlayer.src = currentAudioUrl;

                        if (lastSyncPacket) {
                             const vol = lastSyncPacket.volume ?? 50;
                             neuralPlayer.volume = Math.max(0, Math.min(1, vol / 100));
                             const r = lastSyncPacket.rate ?? 0;
                             neuralPlayer.playbackRate = r >= 0 ? 1 + (r / 10) : 1 + (r / 20);
                        }

                        neuralPlayer.play().catch(e => {
                             console.error('Audio Playback Blocked:', e);
                             postMsg({ command: 'log', message: `[DASHBOARD] Playback Error: ${e.message}` });
                        });

                        if (waveContainer) { waveContainer.classList.add('speaking'); }
                        btnPlay.style.display = 'none';
                        btnPause.style.display = 'inline-block';
                    };

                    // CASE 1: Data provided by extension (Cache Hit in Extension or Fresh Synthesis)
                    if (message.data) {
                        const blob = base64ToBlob(message.data, 'audio/mpeg');
                        handleBuffer(blob);
                        // Save to cache if we have a key
                        if (cacheKey) {
                            cache.set(cacheKey, blob);
                        }
                    } 
                    // CASE 2: No data provided (Zero-IPC Prefetch Hit)
                    else if (cacheKey) {
                        const cachedBlob = await cache.get(cacheKey);
                        if (cachedBlob) {
                            handleBuffer(cachedBlob);
                            cacheDebugTag?.classList.add('pulse');
                            setTimeout(() => cacheDebugTag?.classList.remove('pulse'), 400);
                        } else {
                            // Cache miss in Webview but extension host thought it was there?
                            // Request full synthesis
                            postMsg({ command: 'REQUEST_SYNTHESIS', cacheKey });
                        }
                    } else {
                        console.error('[DASHBOARD] Critical Protocol Failure: [playAudio] received with neither data nor cacheKey.');
                    }
                }
                break;

            case 'synthesisError':
                readAloudController.releaseLock();
                showToast(message.error, message.isFallingBack ? 'warning' : 'error');
                if (message.isFallingBack) {
                    console.warn(`[DASHBOARD] Neural failure at ${message.chapterIndex}:${message.sentenceIndex} for key ${message.cacheKey}. Falling back to SAPI.`);
                } else {
                    console.error(`[DASHBOARD] Critical synthesis failure at ${message.chapterIndex}:${message.sentenceIndex}. Error: ${message.error}`);
                }
                break;
            
            case 'PURGE_MEMORY':
                console.log('[DASHBOARD] PURGING ALL AUDIO OBJECTS...');
                if (neuralPlayer) {
                    neuralPlayer.pause();
                    neuralPlayer.src = '';
                    neuralPlayer.load();
                }
                activeObjectURLs.forEach(url => {
                    try { URL.revokeObjectURL(url); } catch(e) {}
                });
                activeObjectURLs.clear();
                currentAudioUrl = null;
                break;
        }
    }


    function postMsg(msg) {
        if (vscode) { vscode.postMessage(msg); }
    }

    /**
     * Debounces heavy navigation commands (Jump/Next/Prev) 
     * while allowing instant UI feedback to keep things snappy.
     */
    function debouncedPostMsg(msg, delay = 350) {
        if (navDebounceTimer) { clearTimeout(navDebounceTimer); }
        navDebounceTimer = setTimeout(() => {
            postMsg(msg);
            navDebounceTimer = null;
        }, delay);
    }

    function updateAutoPlayModeUI(mode) {
        if (!btnAutoplay) { return; }
        
        // Remove all mode classes
        btnAutoplay.classList.remove('mode-auto', 'mode-chapter', 'mode-row');
        
        switch (mode) {
            case 'chapter':
                btnAutoplay.textContent = '1 CH';
                btnAutoplay.classList.add('active', 'mode-chapter');
                break;
            case 'row':
                btnAutoplay.textContent = '1 ROW';
                btnAutoplay.classList.add('active', 'mode-row');
                break;
            case 'auto':
            default:
                btnAutoplay.textContent = 'AUTO';
                btnAutoplay.classList.add('active', 'mode-auto');
                break;
        }
    }

    // --- Voice Rendering Logic ---
    function renderVoiceList(voicesToUse, selectedVoice, mode, filterTerm = '', forcePause = false) {
        if (!voiceSelect) { return; }
        const term = filterTerm.toLowerCase();
        voiceSelect.innerHTML = '';

        if (mode === 'neural') {
            // ONLY pause if explicitly requested (e.g. engine switch button), not on search or sync
            if (forcePause && neuralPlayer) { neuralPlayer.pause(); }
            engineNeural.classList.add('active');
            engineLocal.classList.remove('active');
            if (engineStatusTag) {
                engineStatusTag.classList.remove('fallback');
            }
            voicesToUse.forEach(v => {
                const name = typeof v === 'string' ? v : v.name;
                const lang = typeof v === 'string' ? '' : v.lang;
                const id = typeof v === 'string' ? v : v.id;

                if (!term || name.toLowerCase().includes(term) || lang.toLowerCase().includes(term)) {
                    const opt = document.createElement('option');
                    opt.value = id;
                    opt.textContent = `✨ ${name} ${lang ? `(${lang})` : ''}`;
                    if (id === selectedVoice) { opt.selected = true; }
                    voiceSelect.appendChild(opt);
                }
            });
        } else {
            engineLocal.classList.add('active');
            engineNeural.classList.remove('active');
            if (engineStatusTag) {
                engineStatusTag.classList.remove('fallback');
            }
            voicesToUse.forEach(v => {
                const name = typeof v === 'string' ? v : v.name;
                const id = typeof v === 'string' ? v : v.id;

                if (!term || name.toLowerCase().includes(term)) {
                    const opt = document.createElement('option');
                    opt.value = id;
                    opt.textContent = name;
                    if (id === selectedVoice) { opt.selected = true; }
                    voiceSelect.appendChild(opt);
                }
            });
        }
    }

    function syncAudioUI(rate, volume) {
        // Prevent feedback loop: If user is dragging the slider, don't let incoming state overwrite it.
        if (isDraggingSlider) { return; }
        if (rateSlider) {
            rateSlider.value = rate;
            rateVal.textContent = (rate > 0 ? '+' : '') + rate;
        }
        if (volumeSlider) {
            volumeSlider.value = volume;
            volumeVal.textContent = volume + '%';
        }
        if (neuralPlayer) {
            const v = volume ?? 50;
            neuralPlayer.volume = Math.max(0, Math.min(1, v / 100));
        }
    }

    // --- Voice select ---
    if (voiceSelect) {
        voiceSelect.onchange = () => {
            const voice = voiceSelect.value;
            postMsg({ command: 'voiceChanged', voice });
        };
    }

    // --- V2 Control Events ---
    if (settingsToggle) {
        settingsToggle.onclick = () => {
            const isOpen = settingsDrawer.classList.toggle('open');
            if (engineToggleGroup) {
                engineToggleGroup.style.display = isOpen ? 'flex' : 'none';
            }
        };
    }

    if (voiceSearch) {
        voiceSearch.oninput = (e) => { 
            if (lastSyncPacket && lastSyncPacket.availableVoices) {
                const mode = lastSyncPacket.engineMode;
                const list = mode === 'neural' ? lastSyncPacket.availableVoices.neural : lastSyncPacket.availableVoices.local;
                renderVoiceList(list, lastSyncPacket.selectedVoice, mode, e.target.value); 
            }
        };
    }

    if (rateSlider) {
        rateSlider.oninput = () => {
            isDraggingSlider = true;
            const val = parseInt(rateSlider.value);
            rateVal.textContent = (val > 0 ? '+' : '') + val;

            // Sync current playback if active
            const isNeural = lastSyncPacket?.engineMode === 'neural';
            if (isNeural && neuralPlayer && !neuralPlayer.paused) {
                neuralPlayer.playbackRate = val >= 0 ? 1 + (val / 10) : 1 + (val / 20);
            }

            postMsg({ command: 'rateChanged', rate: val });
        };
        rateSlider.onchange = () => {
            isDraggingSlider = false;
        };
    }

    if (volumeSlider) {
        volumeSlider.oninput = () => {
            isDraggingSlider = true;
            const val = parseInt(volumeSlider.value);
            volumeVal.textContent = val + '%';

            // Sync current playback if active
            if (neuralPlayer) {
                neuralPlayer.volume = val / 100;
            }

            postMsg({ command: 'volumeChanged', volume: val });
        };
        volumeSlider.onchange = () => {
            isDraggingSlider = false;
        };
    }

    if (btnPlay) {
        btnPlay.onclick = () => {
            readAloudController.play(currentReadingUri);
        };
    }

    const btnClearReader = document.getElementById('btn-clear-reader');
    if (btnClearReader) {
        btnClearReader.onclick = () => {
            postMsg({ command: 'resetContext' });
        };
    }

    if (btnPause) {
        btnPause.onclick = () => {
            readAloudController.pause();
        };
    }

    if (btnStop) {
        btnStop.onclick = () => {
            readAloudController.stop();
        };
    }

    // --- Control Buttons (Debounced) ---
    if (btnPrev) { btnPrev.addEventListener('click', () => { debouncedPostMsg({ command: 'prevChapter' }); }); }
    if (btnNext) { btnNext.addEventListener('click', () => { debouncedPostMsg({ command: 'nextChapter' }); }); }

    if (btnPrevSentence) { btnPrevSentence.onclick = () => { debouncedPostMsg({ command: 'prevSentence' }); }; }
    if (btnNextSentence) { btnNextSentence.onclick = () => { debouncedPostMsg({ command: 'nextSentence' }); }; }

    if (btnAutoplay) {
        btnAutoplay.addEventListener('click', () => {
            const current = lastSyncPacket?.autoPlayMode || 'auto';
            let next = 'auto';
            
            if (current === 'auto') { next = 'chapter'; }
            else if (current === 'chapter') { next = 'row'; }
            else { next = 'auto'; }
            
            updateAutoPlayModeUI(next);
            postMsg({ command: 'setAutoPlayMode', mode: next });
        });
    }


    // --- Audio Synchronization ---
    if (neuralPlayer) {
        neuralPlayer.onended = () => {
            postMsg({ command: 'sentenceEnded' });
        };
    }

    // --- Engine Switching ---
    if (engineLocal) {
        engineLocal.onclick = () => {
            engineLocal.classList.add('active');
            engineNeural.classList.remove('active');
            postMsg({ command: 'engineModeChanged', mode: 'local' });
        };
    }

    if (engineNeural) {
        engineNeural.onclick = () => {
            engineNeural.classList.add('active');
            engineLocal.classList.remove('active');
            postMsg({ command: 'engineModeChanged', mode: 'neural' });
        };

        // Initialize default UI state for Neural
        engineNeural.classList.add('active');
        engineLocal.classList.remove('active');
    }

    if (btnLoadFile) {
        btnLoadFile.onclick = () => {
            postMsg({ command: 'loadDocument' });
            if (settingsDrawer) {
                settingsDrawer.classList.remove('open');
                if (engineToggleGroup) {
                    engineToggleGroup.style.display = 'none';
                }
            }
        };
    }

    // --- Keyboard Shortcuts ---
    window.addEventListener('keydown', (e) => {
        // Don't trigger if typing in search input
        if (document.activeElement === voiceSearch) { return; }
        if (e.repeat) { return; }

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                const ctrlState = readAloudController.getState();
                if (lastSyncPacket && lastSyncPacket.isPlaying && !lastSyncPacket.isPaused) {
                    btnPause.click();
                } else {
                    btnPlay.click();
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (btnNextSentence) { btnNextSentence.click(); }
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (btnPrevSentence) { btnPrevSentence.click(); }
                break;
            case 'ArrowDown':
                e.preventDefault();
                if (btnNext) { btnNext.click(); }
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (btnPrev) { btnPrev.click(); }
                break;
        }
    });

    if (vscode) {
        window.addEventListener('message', event => {
            // Hook new infrastructure into the main event loop
            client.handleMessage(event.data);
            handleCommand(event.data);
        });
        
        // Delegated click listener for file links
        document.body.addEventListener('click', (e) => {
            const link = e.target.closest('.file-link');
            if (link && link.dataset.uri) {
                e.preventDefault();
                postMsg({ command: 'OPEN_FILE', uri: link.dataset.uri });
            }
        });

        // Initial 'ready' signal using high-integrity client
        client.postAction(OutgoingAction.READY);
    }
}());
