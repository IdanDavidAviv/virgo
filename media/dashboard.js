(function() {
    console.log('[DASHBOARD] --- INITIALIZING HANDSHAKE ---');
    if (typeof window.__BRIDGE_CONFIG__ === 'undefined') {
        console.error('[DASHBOARD] CRITICAL: Handshake config missing!');
    } else {
        console.log('[DASHBOARD] Local Route:', `${window.__BRIDGE_CONFIG__.host}:${window.__BRIDGE_CONFIG__.port}`);
    }

    window.onerror = function(msg, url, line, col) {
        const errorDetail = `[DASHBOARD] CRITICAL ERROR: ${msg} at line ${line}:${col}`;
        console.error(errorDetail);
        if (typeof acquireVsCodeApi !== 'undefined') {
            try { acquireVsCodeApi().postMessage({ command: 'error', message: errorDetail }); } catch(e) {}
        }
    };

    let vscode;
    try { vscode = acquireVsCodeApi(); } catch (e) {}

    // --- DOM References ---
    const waveContainer   = document.getElementById('wave-container');
    const voiceSelect     = document.getElementById('voice-select');
    const statusDot       = document.getElementById('status-dot');
    const chapterList     = document.getElementById('chapter-list');
    const chapterProgress = document.getElementById('chapter-progress');
    const btnPrev         = document.getElementById('btn-prev');
    const btnNext         = document.getElementById('btn-next');
    const btnFollow       = document.getElementById('btn-follow');
    const btnAutoplay     = document.getElementById('btn-autoplay');
    
    // V2 References
    const settingsToggle  = document.getElementById('settings-toggle');
    const settingsDrawer  = document.getElementById('settings-drawer');
    const rateSlider      = document.getElementById('rate-slider');
    const rateVal         = document.getElementById('rate-val');
    const volumeSlider    = document.getElementById('volume-slider');
    const volumeVal       = document.getElementById('volume-val');
    const btnPlay         = document.getElementById('btn-play');
    const btnPause        = document.getElementById('btn-pause');
    const btnStop         = document.getElementById('btn-stop');
    const currentSentence = document.getElementById('current-sentence');
    const docFilename     = document.getElementById('doc-filename');
    const docDir          = document.getElementById('doc-dir');
    const engineLocal     = document.getElementById('engine-local');
    const engineNeural    = document.getElementById('engine-neural');
    const neuralPlayer    = document.getElementById('neural-player');
    const btnLoadFile     = document.getElementById('btn-load-file');

    // --- State ---
    let state = (vscode && vscode.getState()) || { selectedVoice: null, followEnabled: false, autoPlayEnabled: true };
    let chapters = [];
    let currentChapterIndex = -1;

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

        chapters.forEach((ch, i) => {
            const item = document.createElement('div');
            item.className = 'chapter-item level-' + ch.level;
            item.dataset.index = i;
            if (i === currentIdx) item.classList.add('now-playing');

            item.innerHTML = `<span class="chapter-play-icon">▶</span><span class="chapter-title">${escapeHtml(ch.title)}</span>`;

            item.addEventListener('click', () => {
                postMsg({ command: 'jumpToChapter', index: i });
            });

            chapterList.appendChild(item);
        });

        updateProgress(currentIdx);
    }

    function updateActiveChapter(index) {
        currentChapterIndex = index;
        document.querySelectorAll('.chapter-item').forEach((el, i) => {
            el.classList.toggle('now-playing', i === index);
        });
        // Scroll the active chapter into view in the sidebar
        const activeEl = chapterList && chapterList.querySelector(`.chapter-item[data-index="${index}"]`);
        if (activeEl) { activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
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
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // --- Message Handler ---
    function handleCommand(message) {
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
                voiceSelect.innerHTML = '';
                
                // Show/Hide engines based on incoming mode
                if (message.engineMode === 'neural') {
                    engineNeural.classList.add('active');
                    engineLocal.classList.remove('active');
                    postMsg({ command: 'log', message: `[DASHBOARD] Rendering ${message.neuralVoices.length} neural voices.` });
                    message.neuralVoices.forEach(v => {
                        const opt = document.createElement('option');
                        opt.value = v.id;
                        opt.textContent = `✨ ${v.name} (${v.lang})`;
                        if (v.id === state.selectedVoice) opt.selected = true;
                        voiceSelect.appendChild(opt);
                    });
                } else {
                    engineLocal.classList.add('active');
                    engineNeural.classList.remove('active');
                    message.voices.forEach(name => {
                        const opt = document.createElement('option');
                        opt.value = name;
                        opt.textContent = name;
                        if (name === state.selectedVoice) opt.selected = true;
                        voiceSelect.appendChild(opt);
                    });
                }
                break;
            case 'playAudio':
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
                    if (currentSentence) {
                        currentSentence.innerHTML = `<span>${escapeHtml(message.text)}</span>`;
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
                if (currentSentence) {
                    currentSentence.innerHTML = `<span>${escapeHtml(message.text)}</span>`;
                }
                if (waveContainer) waveContainer.classList.add('speaking');
                btnPlay.style.display = 'none';
                btnPause.style.display = 'inline-block';
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

    if (btnPlay)    btnPlay.onclick    = () => postMsg({ command: 'continue' });
    
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
    if (btnPrev)  btnPrev.addEventListener('click',  () => postMsg({ command: 'prevChapter' }));
    if (btnNext)  btnNext.addEventListener('click',  () => postMsg({ command: 'nextChapter' }));

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
            try { handleCommand(JSON.parse(event.data)); } catch (e) {}
        };

        _socket.onclose = () => {
            updateStatus(false);
            setTimeout(() => window.location.reload(), 3000);
        };
    }
}());
