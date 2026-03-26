(function() {
    console.log('[DASHBOARD] --- INITIALIZING HANDSHAKE ---');
    if (typeof window.__BRIDGE_CONFIG__ === 'undefined') {
        console.error('[DASHBOARD] CRITICAL: Handshake config missing!');
    } else {
        console.log('[DASHBOARD] Local Route:', `${window.__BRIDGE_CONFIG__.host}:${window.__BRIDGE_CONFIG__.port}`);
    }

    window.onerror = function(msg, url, line, col, error) {
        const errorDetail = `[DASHBOARD] CRITICAL ERROR: ${msg} at line ${line}:${col}`;
        console.error(errorDetail);
        if (typeof acquireVsCodeApi !== 'undefined') {
            try { acquireVsCodeApi().postMessage({ command: 'error', message: errorDetail }); } catch(e) {}
        }
    };

    let vscode;
    try {
        vscode = acquireVsCodeApi();
    } catch (e) {}

    const textDisplay = document.getElementById('text-display');
    const waveContainer = document.getElementById('wave-container');
    const voiceSelect = document.getElementById('voice-select');
    const statusDot = document.getElementById('status-dot');

    // PERSISTENCE: Retrieve last known state
    let state = (vscode && vscode.getState()) || { selectedVoice: null };

    function updateStatus(isOnline) {
        if (statusDot) {
            if (isOnline) {
                statusDot.classList.add('online');
            } else {
                statusDot.classList.remove('online');
            }
        }
    }

    function handleCommand(message) {
        switch (message.command) {
            case 'play':
                waveContainer.classList.add('speaking');
                if (textDisplay) {
                    textDisplay.innerHTML = `<span class="active-text">${message.text.substring(0, 500)}...</span>`;
                }
                break;
            case 'stop':
            case 'pause':
                waveContainer.classList.remove('speaking');
                break;
            case 'voices':
                if (!voiceSelect) return;
                voiceSelect.innerHTML = '';
                message.voices.forEach(name => {
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    if (name === state.selectedVoice) {
                        opt.selected = true;
                    }
                    voiceSelect.appendChild(opt);
                });
                break;
        }
    }

    // INTERACTION: Listen for selection changes
    if (voiceSelect) {
        voiceSelect.onchange = () => {
            state.selectedVoice = voiceSelect.value;
            if (vscode) {
                vscode.setState(state);
                vscode.postMessage({ command: 'voiceChanged', voice: state.selectedVoice });
            }
        };
    }

    if (vscode) {
        // INTERNAL WEBVIEW MODE
        window.addEventListener('message', event => handleCommand(event.data));
        updateStatus(true);
        vscode.postMessage({ command: 'ready' });
    } else {
        // EXTERNAL BROWSER MODE (WEBSOCKETS)
        const config = window.__BRIDGE_CONFIG__ || { host: '127.0.0.1', port: 3001 };
        const socket = new WebSocket(`ws://${config.host}:${config.port}`);
        
        socket.onopen = () => {
            updateStatus(true);
            socket.send(JSON.stringify({ command: 'ready' }));
        };

        socket.onmessage = (event) => {
            try {
                handleCommand(JSON.parse(event.data));
            } catch (e) {}
        };

        socket.onclose = () => {
            updateStatus(false);
            setTimeout(() => window.location.reload(), 3000);
        };
    }
}());
