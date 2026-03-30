(function () {
    window.onerror = function (msg, url, line, col) {
        const errorDetail = `[DASHBOARD] CRITICAL ERROR: ${msg} at line ${line}:${col}`;
        console.error(errorDetail);
        if (window.vscode) {
            try { window.vscode.postMessage({ command: 'error', message: errorDetail }); } catch (e) { }
        }
    };

    const vscode = window.vscode;
    
    // --- State ---
    let state = (vscode && vscode.getState()) || { selectedVoice: null, autoPlayMode: 'auto', rate: 0, volume: 50 };
    if (typeof state.rate === 'undefined') { state.rate = 0; }
    if (typeof state.volume === 'undefined') { state.volume = 50; }
    let chapters = [];
    let currentChapterIndex = -1;
    let availableVoices = []; // Global copy for searching
    let engineMode = 'local';
    let isSynthesizing = false;
    let collapsedIndices = new Set();
    let lastHighlightedLine = -1;
    let navDebounceTimer = null;

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
        if (rateSlider) {
            rateSlider.value = state.rate;
            if (rateVal) { rateVal.textContent = (state.rate > 0 ? '+' : '') + state.rate; }
        }
        if (volumeSlider) {
            volumeSlider.value = state.volume;
            if (volumeVal) { volumeVal.textContent = state.volume + '%'; }
        }
        if (neuralPlayer) {
            neuralPlayer.volume = state.volume / 100;
            const val = state.rate;
            neuralPlayer.playbackRate = val >= 0 ? 1 + (val / 10) : 1 + (val / 20);
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
        waveContainer = document.querySelector('.wave-container');

        console.log('[DASHBOARD] DOM Selection complete.');
        
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

    let currentReadingUri = null;
    let currentAudioUrl = null;
    let activeObjectURLs = new Set();


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
            item.innerHTML = `
                <span class="chevron">${chevronIcon}</span>
                <span class="chapter-title">${escapeHtml(ch.title)}</span>
                <span class="chapter-row-count">${rowCount} rows</span>
                <span class="chapter-play-icon">▶</span>
            `;

            // Click Logic: Chevron ONLY toggles; Row selection ONLY plays
            item.onclick = (e) => {
                if (e.target.classList.contains('chevron')) {
                    if (isParent) { toggleCollapse(i); }
                    return;
                }
                
                // --- INSTANT VISUAL FEEDBACK (Chapter) ---
                syncPlaybackUI(i, 0, ch.count || 0);

                // --- DEBOUNCED COMMAND ---
                debouncedPostMsg({ command: 'jumpToChapter', index: i });
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
        if (chapterIndex !== undefined) { currentChapterIndex = chapterIndex; }

        // 2. Update Progress Header (Title Bar)
        if (!chapterProgress || chapters.length === 0) {
            chapterProgress.innerHTML = '—';
        } else {
            const chStr = `${currentChapterIndex + 1} / ${chapters.length}`;
            const rowStr = totalSentences ? `<span style="opacity: 0.5; margin: 0 8px;">•</span><span style="font-weight: 400; opacity: 0.8;">ROW ${sentenceIndex + 1} / ${totalSentences}</span>` : '';
            chapterProgress.innerHTML = `${chStr}${rowStr}`;
        }

        // 3. Update Chapter List Highlights
        const allItems = chapterList ? chapterList.querySelectorAll('.chapter-item') : [];
        allItems.forEach((el) => {
            el.classList.toggle('now-playing', parseInt(el.dataset.index) === currentChapterIndex);
        });

        // 4. Managed Scrolling
        const activeEl = chapterList && chapterList.querySelector(`.chapter-item[data-index="${currentChapterIndex}"]`);
        if (activeEl) {
            activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function escapeHtml(str) {
        if (!str) { return ''; }
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

    // --- Loading UI Helpers ---
    function setLoading(loading) {
        isSynthesizing = loading;
        if (btnPlay) {
            loading ? btnPlay.classList.add('is-loading') : btnPlay.classList.remove('is-loading');
        }
    }

    // --- Context Parsing ---
    function updateContextSlot(uri, filenameEl, dirEl, version, precalcName, precalcDir) {
        if (!uri) {
            filenameEl.textContent = filenameEl.id === 'reader-filename' ? 'No File Loaded' : 'No Selection';
            dirEl.textContent = '';
            return;
        }

        const filename = precalcName || uri.split(/[\\\/]/).pop() || '';
        const dir = precalcDir !== undefined ? precalcDir : (uri.split(/[\\\/]/).length > 3 ? uri.split(/[\\\/]/).slice(-3).join('/') : '');

        // Only show explicit 'V' versions as badges in UI.
        // 'T' versions (timestamps) are internal salts only.
        const versionHtml = version && version.startsWith('V') ? `<span class="version-badge">${version}</span>` : '';
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
    function updateSentenceNavigator(sentences, currentIndex) {
        if (!sentenceCurrent) { return; }

        const prevIdx = currentIndex - 1;
        const nextIdx = currentIndex + 1;

        const prevText = prevIdx >= 0 ? sentences[prevIdx] : '';
        const currText = sentences[currentIndex] || '';
        const nextText = nextIdx < sentences.length ? sentences[nextIdx] : '';

        updateRow(sentencePrev, prevText, prevIdx >= 0 ? prevIdx : null);
        updateRow(sentenceCurrent, currText, currentIndex);
        updateRow(sentenceNext, nextText, nextIdx < sentences.length ? nextIdx : null);
    }

    function updateRow(el, text, idx) {
        if (!el) { return; }
        
        // Always show the element to maintain the 3-slot layout
        el.style.display = 'flex';
        
        if (!text) {
            el.innerHTML = '<span class="sentence-placeholder">&nbsp;</span>';
            el.onclick = null;
            el.style.pointerEvents = 'none';
            el.style.opacity = '0';
            return;
        }

        el.style.pointerEvents = 'auto';
        el.style.opacity = el.classList.contains('current') ? '1' : '0.15';
        el.innerHTML = `<span>${escapeHtml(text)}</span>`;

        // Interaction: Click to jump
        if (idx !== null) {
            el.onclick = () => {
                // --- INSTANT VISUAL FEEDBACK (Sentence) ---
                const allRows = sentenceNavigator?.querySelectorAll('.sentence-row') || [];
                allRows.forEach(r => r.classList.remove('current'));
                el.classList.add('current');
                el.style.opacity = '1';

                // --- DEBOUNCED COMMAND ---
                debouncedPostMsg({ command: 'jumpToSentence', index: idx });
            };
        } else {
            el.onclick = null;
        }

        // RTL Detection
        const isHebrew = /[\u0590-\u05FF]/.test(text);
        el.classList.toggle('rtl', isHebrew);
    }

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

        console.log(`[DASHBOARD -> EXTENSION] [${command.toUpperCase()}] ${payload}`);
    }

    function updateStateDebug(state) {
        const tag = document.getElementById('state-debug-tag');
        if (!tag) {
            return;
        }
        
        // Fallback to local state if sync doesn't have it yet
        const vol = state.volume !== undefined ? state.volume : (localStorage.getItem('readAloud.volume') || 50);
        const rate = state.rate !== undefined ? state.rate : (localStorage.getItem('readAloud.rate') || 0);
        
        // Normalize rate display to match slider (0 is 1.0x)
        const displayRate = (1 + (rate / 10)).toFixed(1);
        
        tag.textContent = `[ V:${vol} | R:${displayRate}x ]`;
    }

    // --- Message Handler ---
    function handleCommand(message) {
        logSafeMessage(message);
        switch (message.command) {
            case 'chapters':
                renderChapters(message.chapters, message.current);
                break;
            case 'chapterChanged':
                syncPlaybackUI(message.index, 0, message.totalSentences || 0);
                break;
            case 'state-sync':
                // Dual context update
                currentReadingUri = message.readingUri;
                updateContextSlot(message.activeUri, activeFilename, activeDir, message.activeVersion, message.activeFileName, message.activeRelativeDir);
                updateContextSlot(message.readingUri, readerFilename, readerDir, message.readingVersion, message.readingFileName, message.readingRelativeDir);
                syncPlaybackUI(message.currentChapterIndex, message.currentSentenceIndex, message.totalSentences);
                updateStateDebug(message);

                // Mismatch Pulse
                if (btnLoadFile) {
                    btnLoadFile.disabled = !message.activeUri;
                    const isMismatch = message.activeUri && message.activeUri !== message.readingUri;
                    btnLoadFile.classList.toggle('mismatch', !!isMismatch);
                }
                break;
            case 'stop':
            case 'pause':
                btnPlay.style.display = 'inline-block';
                btnPause.style.display = 'none';
                break;
            case 'voiceChanged':
                state.selectedVoice = message.voice;
                if (vscode) { vscode.setState(state); }
                break;
            case 'voices':
                if (!voiceSelect) { return; }
                engineMode = message.engineMode;
                availableVoices = (engineMode === 'neural') ? message.neuralVoices : message.voices;
                renderVoiceList();
                break;
            case 'playAudio':
                setLoading(false); // Clear synthesis loading
                if (neuralPlayer) {
                    postMsg({ command: 'log', message: `[DASHBOARD] Starting playback: ${message.text.substring(0, 30)}...` });
                    
                    // MEMORY MANAGEMENT: Revoke previous URL to free browser memory
                    if (currentAudioUrl) {
                        try {
                            URL.revokeObjectURL(currentAudioUrl);
                            activeObjectURLs.delete(currentAudioUrl);
                        } catch (e) {}
                    }

                    const blob = base64ToBlob(message.data, 'audio/mpeg');
                    currentAudioUrl = URL.createObjectURL(blob);
                    activeObjectURLs.add(currentAudioUrl);
                    neuralPlayer.src = currentAudioUrl;


                    // Apply current volume/rate settings immediately
                    neuralPlayer.volume = state.volume / 100;
                    const r = state.rate;
                    neuralPlayer.playbackRate = r >= 0 ? 1 + (r / 10) : 1 + (r / 20);

                    neuralPlayer.play().catch(e => {
                        console.error('Audio Playback Blocked:', e);
                        postMsg({ command: 'log', message: `[DASHBOARD] Playback Error: ${e.message}` });
                    });

                    if (message.sentences) {
                        updateSentenceNavigator(message.sentences, message.sentenceIndex || 0);
                    } else if (sentenceCurrent) {
                        updateRow(sentenceCurrent, message.text);
                    }

                    if (waveContainer) { waveContainer.classList.add('speaking'); }
                    btnPlay.style.display = 'none';
                    btnPause.style.display = 'inline-block';

                    syncPlaybackUI(message.chapterIndex, message.sentenceIndex, message.totalSentences);
                }
                break;
            case 'initialState':
                // Sync sliders and toggles with backend SSOT
                if (message.selectedVoice) { state.selectedVoice = message.selectedVoice; }
                state.rate = typeof message.rate !== 'undefined' ? message.rate : state.rate;
                state.volume = typeof message.volume !== 'undefined' ? message.volume : state.volume;
                
                syncAudioUI();
                if (vscode) { vscode.setState(state); }

                // Context Slots
                currentReadingUri = message.readingUri;
                updateContextSlot(message.activeUri, activeFilename, activeDir, message.activeVersion, message.activeFileName, message.activeRelativeDir);
                updateContextSlot(message.readingUri, readerFilename, readerDir, message.readingVersion, message.readingFileName, message.readingRelativeDir);
                
                if (btnLoadFile) {
                    btnLoadFile.disabled = !message.activeUri;
                    const isMismatch = message.activeUri && message.activeUri !== message.readingUri;
                    btnLoadFile.classList.toggle('mismatch', !!isMismatch);
                }

                // --- NEW CENTRALIZED SYNC ---
                if (message.autoPlayMode) {
                    updateAutoPlayModeUI(message.autoPlayMode);
                updateStateDebug(message);
                }
                syncPlaybackUI(message.currentChapterIndex, message.currentSentenceIndex, message.totalSentences);
                break;
            case 'documentInfo':
                // Trigger transfer animation
                if (readerSlot) {
                    readerSlot.classList.remove('transfer-anim-active');
                    void readerSlot.offsetWidth; // Trigger reflow
                    readerSlot.classList.add('transfer-anim-active');
                }
                
                // Update Context Slot directly on metadata change
                updateContextSlot(currentReadingUri, readerFilename, readerDir, message.version);
                break;
            case 'sentenceChanged':
                setLoading(false); // Clear if jumping directly
                if (message.sentences) {
                    updateSentenceNavigator(message.sentences, message.sentenceIndex);
                } else if (sentenceCurrent) {
                    updateRow(sentenceCurrent, message.text);
                }
                
                if (!message.suppressButtonToggle) {
                    btnPlay.style.display = 'none';
                    btnPause.style.display = 'inline-block';
                }
                syncPlaybackUI(message.chapterIndex, message.sentenceIndex, message.totalSentences);
                break;

            case 'synthesisError':
                setLoading(false);
                showToast(message.error, message.isFallingBack ? 'warning' : 'error');
                if (message.isFallingBack) {
                    console.warn('[DASHBOARD] Neural failure. Falling back to SAPI.');
                }
                break;

            case 'engineStatus':
                if (engineStatusTag) {
                    if (message.status === 'local-fallback') {
                        engineStatusTag.textContent = 'LOCAL FALLBACK';
                        engineStatusTag.classList.add('fallback');
                    } else {
                        engineStatusTag.textContent = engineMode.toUpperCase();
                        engineStatusTag.classList.remove('fallback');
                    }
                }
                break;
            
            case 'cacheStatus':
                if (cacheDebugTag) {
                    const count = message.count || 0;
                    const sizeBytes = message.sizeBytes || 0;
                    const mb = (sizeBytes / (1024 * 1024)).toFixed(1);
                    
                    cacheDebugTag.textContent = `[ CACHE: ${count}/100 | ${mb}MB ]`;
                    console.log(`[DASHBOARD] Cache Status Update: ${count}/100 segments, ${mb}MB`);

                    // Add a pulse effect on update
                    cacheDebugTag.classList.remove('pulse');
                    void cacheDebugTag.offsetWidth; // Trigger reflow
                    cacheDebugTag.classList.add('pulse');
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
    function renderVoiceList(filterTerm = '') {
        if (!voiceSelect) { return; }
        const term = filterTerm.toLowerCase();
        voiceSelect.innerHTML = '';

        if (engineMode === 'neural') {
            if (neuralPlayer) { neuralPlayer.pause(); }
            engineNeural.classList.add('active');
            engineLocal.classList.remove('active');
            if (engineStatusTag) {
                engineStatusTag.classList.remove('fallback');
            }
            availableVoices.forEach(v => {
                if (!term || v.name.toLowerCase().includes(term) || v.lang.toLowerCase().includes(term)) {
                    const opt = document.createElement('option');
                    opt.value = v.id;
                    opt.textContent = `✨ ${v.name} (${v.lang})`;
                    if (v.id === state.selectedVoice) { opt.selected = true; }
                    voiceSelect.appendChild(opt);
                }
            });
        } else {
            engineLocal.classList.add('active');
            engineNeural.classList.remove('active');
            if (engineStatusTag) {
                engineStatusTag.classList.remove('fallback');
            }
            availableVoices.forEach(name => {
                if (!term || name.toLowerCase().includes(term)) {
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    if (name === state.selectedVoice) { opt.selected = true; }
                    voiceSelect.appendChild(opt);
                }
            });
        }
    }

    // --- Voice select ---
    if (voiceSelect) {
        voiceSelect.onchange = () => {
            const voice = voiceSelect.value;
            state.selectedVoice = voice;
            if (vscode) { vscode.setState(state); }
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
        voiceSearch.oninput = (e) => { renderVoiceList(e.target.value); };
    }

    if (rateSlider) {
        rateSlider.oninput = () => {
            const val = parseInt(rateSlider.value);
            state.rate = val;
            rateVal.textContent = (val > 0 ? '+' : '') + val;

            // Sync current playback if active
            if (engineMode === 'neural' && neuralPlayer && !neuralPlayer.paused) {
                neuralPlayer.playbackRate = val >= 0 ? 1 + (val / 10) : 1 + (val / 20);
            }

            postMsg({ command: 'rateChanged', rate: val });
            if (vscode) { vscode.setState(state); }
        };
    }

    if (volumeSlider) {
        volumeSlider.oninput = () => {
            const val = parseInt(volumeSlider.value);
            state.volume = val;
            volumeVal.textContent = val + '%';

            // Sync current playback if active
            if (neuralPlayer) {
                neuralPlayer.volume = val / 100;
            }

            postMsg({ command: 'volumeChanged', volume: val });
            if (vscode) { vscode.setState(state); }
        };
    }

    if (btnPlay) {
        btnPlay.onclick = () => {
            setLoading(true); // Trigger synthesis loading visual
            if (!currentReadingUri) {
                postMsg({ command: 'loadAndPlay' });
            } else {
                postMsg({ command: 'continue' });
            }
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
                    if (neuralPlayer) {
                        neuralPlayer.pause();
                        btnPlay.style.display = 'inline-block';
                        btnPause.style.display = 'none';
                    }
                    postMsg({ command: 'pause' });
                };
            }

            if (btnStop) {
                btnStop.onclick = () => {
                    if (neuralPlayer) {
                        neuralPlayer.pause();
                        neuralPlayer.currentTime = 0;
                        btnPlay.style.display = 'inline-block';
                        btnPause.style.display = 'none';
                    }
                    postMsg({ command: 'stop' });
                };
            }

    // --- Control Buttons (Debounced) ---
    if (btnPrev) { btnPrev.addEventListener('click', () => { debouncedPostMsg({ command: 'prevChapter' }); }); }
    if (btnNext) { btnNext.addEventListener('click', () => { debouncedPostMsg({ command: 'nextChapter' }); }); }

    if (btnPrevSentence) { btnPrevSentence.onclick = () => { debouncedPostMsg({ command: 'prevSentence' }); }; }
    if (btnNextSentence) { btnNextSentence.onclick = () => { debouncedPostMsg({ command: 'nextSentence' }); }; }

    if (btnAutoplay) {
        // Restore persisted state (default: auto)
        const initMode = state.autoPlayMode || 'auto';
        updateAutoPlayModeUI(initMode);

        btnAutoplay.addEventListener('click', () => {
            const current = state.autoPlayMode || 'auto';
            let next = 'auto';
            
            if (current === 'auto') { next = 'chapter'; }
            else if (current === 'chapter') { next = 'row'; }
            else { next = 'auto'; }
            
            state.autoPlayMode = next;
            updateAutoPlayModeUI(next);
            
            if (vscode) { vscode.setState(state); }
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

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                if (btnPause && btnPause.style.display !== 'none') {
                    btnPause.click();
                } else if (btnPlay) {
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
        }
    });

    if (vscode) {
        window.addEventListener('message', event => handleCommand(event.data));
        vscode.postMessage({ command: 'ready' });
    }
}());
