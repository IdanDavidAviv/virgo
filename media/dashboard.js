(function () {
    console.log('[DASHBOARD] --- INITIALIZING HANDSHAKE ---');
    if (typeof window.__BRIDGE_CONFIG__ === 'undefined') {
        console.error('[DASHBOARD] CRITICAL: Handshake config missing!');
    } else {
        console.log('[DASHBOARD] Local Route:', `${window.__BRIDGE_CONFIG__.host}:${window.__BRIDGE_CONFIG__.port}`);
    }

    window.onerror = function (msg, url, line, col) {
        const errorDetail = `[DASHBOARD] CRITICAL ERROR: ${msg} at line ${line}:${col}`;
        console.error(errorDetail);
        if (typeof acquireVsCodeApi !== 'undefined') {
            try { acquireVsCodeApi().postMessage({ command: 'error', message: errorDetail }); } catch (e) { }
        }
    };

    let vscode;
    try { vscode = acquireVsCodeApi(); } catch (e) { }

    // --- DOM References ---
    const waveContainer = document.getElementById('wave-container');
    const voiceSelect = document.getElementById('voice-select');
    const statusDot = document.getElementById('status-dot');
    const chapterList = document.getElementById('chapter-list');
    const chapterProgress = document.getElementById('chapter-progress');
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const btnFollow = document.getElementById('btn-follow');
    const btnAutoplay = document.getElementById('btn-autoplay');

    // V2 References
    const settingsToggle = document.getElementById('settings-toggle');
    const settingsDrawer = document.getElementById('settings-drawer');
    const rateSlider = document.getElementById('rate-slider');
    const rateVal = document.getElementById('rate-val');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeVal = document.getElementById('volume-val');
    const btnPlay = document.getElementById('btn-play');
    const btnPause = document.getElementById('btn-pause');
    const btnStop = document.getElementById('btn-stop');
    const sentenceNavigator = document.getElementById('sentence-navigator');
    const sentencePrev = document.getElementById('sentence-prev');
    const sentenceCurrent = document.getElementById('sentence-current');
    const sentenceNext = document.getElementById('sentence-next');
    const btnPrevSentence = document.getElementById('btn-prev-sentence');
    const btnNextSentence = document.getElementById('btn-next-sentence');
    const docFilename = document.getElementById('doc-filename');
    const docDir = document.getElementById('doc-dir');
    const engineLocal = document.getElementById('engine-local');
    const engineNeural = document.getElementById('engine-neural');
    const neuralPlayer = document.getElementById('neural-player');
    const btnLoadFile = document.getElementById('btn-load-file');
    const voiceSearch = document.getElementById('voice-search');
    const toastContainer = document.getElementById('toast-container');
    const engineStatusTag = document.getElementById('engine-status-tag');
    const cacheDebugTag = document.getElementById('cache-debug-tag');

    // --- State ---
    let state = (vscode && vscode.getState()) || { selectedVoice: null, followEnabled: false, autoPlayEnabled: true };
    let chapters = [];
    let currentChapterIndex = -1;
    let availableVoices = []; // Global copy for searching
    let engineMode = 'local';
    let isSynthesizing = false;
    let collapsedIndices = new Set();

    // --- Status Dot ---
    function updateStatus(isOnline) {
        if (statusDot) {
            isOnline ? statusDot.classList.add('online') : statusDot.classList.remove('online');
        }
    }

    // --- Chapter Rendering ---
    function renderChapters(chapterData, currentIdx) {
        if (!chapterList) return;
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
            if (i === currentIdx) item.classList.add('now-playing');
            
            const isParent = (i < chapters.length - 1 && chapters[i + 1].level > ch.level);
            
            if (isParent && collapsedIndices.has(i)) {
                item.classList.add('collapsed');
                if (hideLevelAt === Infinity) hideLevelAt = ch.level;
            }

            if (ch.level > hideLevelAt) {
                item.classList.add('is-hidden');
            }

            const chevronIcon = isParent ? '▼' : '';
            item.innerHTML = `
                <span class="chevron">${chevronIcon}</span>
                <span class="chapter-play-icon">▶</span>
                <span class="chapter-title">${escapeHtml(ch.title)}</span>
            `;

            // Click Logic: Chevron ONLY toggles; Row selection ONLY plays
            item.onclick = (e) => {
                if (e.target.classList.contains('chevron')) {
                    if (isParent) toggleCollapse(i);
                    return;
                }
                
                // Clicking anywhere else on the row ONLY triggers playback
                postMsg({ command: 'jumpToChapter', index: i });
            };

            chapterList.appendChild(item);
        });

        updateProgress(currentIdx);
    }

    function toggleCollapse(index) {
        if (collapsedIndices.has(index)) {
            collapsedIndices.delete(index);
        } else {
            collapsedIndices.add(index);
        }
        renderChapters(chapters, currentChapterIndex);
    }

    function updateActiveChapter(index) {
        currentChapterIndex = index;
        const allItems = chapterList ? chapterList.querySelectorAll('.chapter-item') : [];
        allItems.forEach((el, i) => {
            el.classList.toggle('now-playing', parseInt(el.dataset.index) === index);
        });

        const activeEl = chapterList && chapterList.querySelector(`.chapter-item[data-index="${index}"]`);
        if (activeEl) {
            // Auto-expand flattened ancestors if hidden
            let expanded = false;
            let currentLevel = chapters[index].level;
            for (let i = index - 1; i >= 0; i--) {
                const prev = chapters[i];
                if (prev.level < currentLevel) {
                    if (collapsedIndices.has(i)) {
                        collapsedIndices.delete(i);
                        expanded = true;
                    }
                    currentLevel = prev.level;
                }
                if (currentLevel === 1) break;
            }

            if (expanded) {
                renderChapters(chapters, index);
            } else {
                activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
        updateProgress(index);
    }

    function updateProgress(index) {
        if (!chapterProgress || chapters.length === 0) return;
        if (index < 0 || index >= chapters.length) {
            chapterProgress.textContent = '—';
        } else {
            chapterProgress.textContent = `${index + 1} / ${chapters.length}`;
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // --- Loading UI Helpers ---
    function setLoading(loading) {
        isSynthesizing = loading;
        if (btnPlay) {
            loading ? btnPlay.classList.add('is-loading') : btnPlay.classList.remove('is-loading');
        }
        if (waveContainer) {
            // Waveform pulse is only for NEURAL synthesis
            if (loading && engineMode === 'neural') {
                waveContainer.classList.add('is-synthesizing');
            } else {
                waveContainer.classList.remove('is-synthesizing');
            }
        }
    }

    // --- Toast Notifications ---
    function showToast(message, type = 'info') {
        if (!toastContainer) return;
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        let icon = 'ℹ️';
        if (type === 'error') icon = '❌';
        if (type === 'warning') icon = '⚠️';
        
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
        if (!sentenceCurrent) return;

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
        if (!el) return;
        if (!text) {
            el.innerHTML = '';
            el.style.display = 'none';
            el.onclick = null;
            return;
        }
        el.style.display = 'flex';
        el.innerHTML = `<span>${escapeHtml(text)}</span>`;

        // Interaction: Click to jump
        if (idx !== null) {
            el.onclick = () => postMsg({ command: 'jumpToSentence', index: idx });
        } else {
            el.onclick = null;
        }

        // RTL Detection
        const isHebrew = /[\u0590-\u05FF]/.test(text);
        el.classList.toggle('rtl', isHebrew);
    }

    // --- Message Handler ---
    function handleCommand(message) {
        console.log('[DASHBOARD RECEIVED]', message);
        switch (message.command) {
            case 'chapters':
                renderChapters(message.chapters, message.current);
                // Waveform active
                if (waveContainer) waveContainer.classList.add('speaking');
                break;
            case 'chapterChanged':
                updateActiveChapter(message.index);
                if (waveContainer) waveContainer.classList.add('speaking');
                break;
            case 'stop':
            case 'pause':
                if (waveContainer) waveContainer.classList.remove('speaking');
                btnPlay.style.display = 'inline-block';
                btnPause.style.display = 'none';
                break;
            case 'voices':
                if (!voiceSelect) return;
                engineMode = message.engineMode;
                availableVoices = (engineMode === 'neural') ? message.neuralVoices : message.voices;
                renderVoiceList();
                break;
            case 'playAudio':
                setLoading(false); // Clear synthesis loading
                if (neuralPlayer) {
                    postMsg({ command: 'log', message: `[DASHBOARD] Starting playback: ${message.text.substring(0, 30)}...` });
                    neuralPlayer.src = `data:audio/mpeg;base64,${message.data}`;

                    // Apply current volume/rate settings immediately
                    neuralPlayer.volume = (state.volume || 100) / 100;
                    const r = state.rate || 0;
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

                    if (waveContainer) waveContainer.classList.add('speaking');
                    btnPlay.style.display = 'none';
                    btnPause.style.display = 'inline-block';
                }
                break;
            case 'initialState':
                // Sync sliders and toggles with backend SSOT
                if (rateSlider) {
                    rateSlider.value = message.rate;
                    rateVal.textContent = (message.rate > 0 ? '+' : '') + message.rate;
                }
                if (volumeSlider) {
                    volumeSlider.value = message.volume;
                    volumeVal.textContent = message.volume + '%';
                }
                if (voiceSelect && message.voice) {
                    voiceSelect.value = message.voice;
                }

                // Sync internal dashboard state with backend values
                state.rate = message.rate;
                state.volume = message.volume;
                if (vscode) vscode.setState(state);

                if (docFilename && message.fileName) {
                    docFilename.textContent = message.fileName;
                }
                if (docDir && message.relativeDir) {
                    docDir.textContent = message.relativeDir + ' /';
                }
                break;
            case 'documentInfo':
                if (docFilename) {
                    docFilename.textContent = message.fileName;
                    if (docDir) {
                        docDir.textContent = message.relativeDir ? message.relativeDir + ' /' : '';
                    }
                    // Flash effect for update visibility
                    docFilename.style.opacity = '0.5';
                    setTimeout(() => docFilename.style.opacity = '1', 200);
                }
                break;
            case 'sentenceChanged':
                setLoading(false); // Clear if jumping directly
                if (message.sentences) {
                    updateSentenceNavigator(message.sentences, message.sentenceIndex);
                } else if (sentenceCurrent) {
                    updateRow(sentenceCurrent, message.text);
                }
                
                // If chapter/sentence changes via SAPI, we still want the "speaking" animation (bars bouncing)
                if (waveContainer) waveContainer.classList.add('speaking');
                btnPlay.style.display = 'none';
                btnPause.style.display = 'inline-block';
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
        }
    }

    // --- Post message helper (works in both webview and websocket modes) ---
    let _socket = null;
    function postMsg(msg) {
        if (vscode) {
            vscode.postMessage(msg);
        } else if (_socket && _socket.readyState === WebSocket.OPEN) {
            _socket.send(JSON.stringify(msg));
        }
    }

    // --- Voice Rendering Logic ---
    function renderVoiceList(filterTerm = '') {
        if (!voiceSelect) return;
        const term = filterTerm.toLowerCase();
        voiceSelect.innerHTML = '';

        if (engineMode === 'neural') {
            engineNeural.classList.add('active');
            engineLocal.classList.remove('active');
            if (engineStatusTag) {
                engineStatusTag.textContent = 'NEURAL';
                engineStatusTag.classList.remove('fallback');
            }
            availableVoices.forEach(v => {
                if (!term || v.name.toLowerCase().includes(term) || v.lang.toLowerCase().includes(term)) {
                    const opt = document.createElement('option');
                    opt.value = v.id;
                    opt.textContent = `✨ ${v.name} (${v.lang})`;
                    if (v.id === state.selectedVoice) opt.selected = true;
                    voiceSelect.appendChild(opt);
                }
            });
        } else {
            engineLocal.classList.add('active');
            engineNeural.classList.remove('active');
            if (engineStatusTag) {
                engineStatusTag.textContent = 'NATIVE';
                engineStatusTag.classList.remove('fallback');
            }
            availableVoices.forEach(name => {
                if (!term || name.toLowerCase().includes(term)) {
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    if (name === state.selectedVoice) opt.selected = true;
                    voiceSelect.appendChild(opt);
                }
            });
        }
    }

    // --- Voice select ---
    if (voiceSelect) {
        voiceSelect.onchange = () => {
            state.selectedVoice = voiceSelect.value;
            if (vscode) vscode.setState(state);
            postMsg({ command: 'voiceChanged', voice: state.selectedVoice });
        };
    }

    // --- V2 Control Events ---
    if (settingsToggle) {
        settingsToggle.onclick = () => settingsDrawer.classList.toggle('open');
    }

    if (voiceSearch) {
        voiceSearch.oninput = (e) => renderVoiceList(e.target.value);
    }

    if (rateSlider) {
        rateSlider.oninput = () => {
            const val = parseInt(rateSlider.value);
            state.rate = val;
            rateVal.textContent = (val > 0 ? '+' : '') + val;

            // Sync current playback if active
            if (neuralPlayer && !neuralPlayer.paused) {
                neuralPlayer.playbackRate = val >= 0 ? 1 + (val / 10) : 1 + (val / 20);
            }

            postMsg({ command: 'rateChanged', rate: val });
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
        };
    }

    if (btnPlay) {
        btnPlay.onclick = () => {
            setLoading(true); // Trigger synthesis loading visual
            postMsg({ command: 'continue' });
        };
    }

    if (btnPause) {
        btnPause.onclick = () => {
            if (neuralPlayer) {
                neuralPlayer.pause();
                if (waveContainer) waveContainer.classList.remove('speaking');
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
                if (waveContainer) waveContainer.classList.remove('speaking');
                btnPlay.style.display = 'inline-block';
                btnPause.style.display = 'none';
            }
            postMsg({ command: 'stop' });
        };
    }

    // --- Control Buttons ---
    if (btnPrev) btnPrev.addEventListener('click', () => postMsg({ command: 'prevChapter' }));
    if (btnNext) btnNext.addEventListener('click', () => postMsg({ command: 'nextChapter' }));

    if (btnPrevSentence) btnPrevSentence.onclick = () => postMsg({ command: 'prevSentence' });
    if (btnNextSentence) btnNextSentence.onclick = () => postMsg({ command: 'nextSentence' });

    if (btnFollow) {
        // Restore persisted state
        if (state.followEnabled) btnFollow.classList.add('active');
        btnFollow.dataset.active = state.followEnabled ? 'true' : 'false';

        btnFollow.addEventListener('click', () => {
            const isActive = btnFollow.dataset.active === 'true';
            const next = !isActive;
            btnFollow.dataset.active = next ? 'true' : 'false';
            btnFollow.classList.toggle('active', next);
            state.followEnabled = next;
            if (vscode) vscode.setState(state);
            postMsg({ command: 'toggleFollow', enabled: next });
        });
    }

    if (btnAutoplay) {
        // Restore persisted state (default: true)
        const initAuto = state.autoPlayEnabled !== false;
        btnAutoplay.dataset.active = initAuto ? 'true' : 'false';
        btnAutoplay.classList.toggle('active', initAuto);

        btnAutoplay.addEventListener('click', () => {
            const isActive = btnAutoplay.dataset.active === 'true';
            const next = !isActive;
            btnAutoplay.dataset.active = next ? 'true' : 'false';
            btnAutoplay.classList.toggle('active', next);
            state.autoPlayEnabled = next;
            if (vscode) vscode.setState(state);
            postMsg({ command: 'toggleAutoPlay', enabled: next });
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
        btnLoadFile.onclick = () => postMsg({ command: 'loadDocument' });
    }

    // --- Keyboard Shortcuts ---
    window.addEventListener('keydown', (e) => {
        // Don't trigger if typing in search input
        if (document.activeElement === voiceSearch) return;

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
                if (btnNextSentence) btnNextSentence.click();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (btnPrevSentence) btnPrevSentence.click();
                break;
        }
    });

    // --- Connection Mode: Internal Webview vs External Browser ---
    if (vscode) {
        window.addEventListener('message', event => handleCommand(event.data));
        updateStatus(true);
        vscode.postMessage({ command: 'ready' });
    } else {
        const config = window.__BRIDGE_CONFIG__ || { host: '127.0.0.1', port: 3001 };
        _socket = new WebSocket(`ws://${config.host}:${config.port}`);

        _socket.onopen = () => {
            updateStatus(true);
            _socket.send(JSON.stringify({ command: 'ready' }));
        };

        _socket.onmessage = (event) => {
            try { handleCommand(JSON.parse(event.data)); } catch (e) { }
        };

        _socket.onclose = () => {
            updateStatus(false);
            setTimeout(() => window.location.reload(), 3000);
        };
    }
}());
