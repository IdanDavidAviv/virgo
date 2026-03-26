(function() {
    const vscode = acquireVsCodeApi();
    const textDisplay = document.getElementById('text-display');
    const waveContainer = document.getElementById('wave-container');
    const voiceSelect = document.getElementById('voice-select');

    console.log('--- DASHBOARD JS BOOTED ---');

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'play':
                waveContainer.classList.add('speaking');
                textDisplay.innerHTML = `<span class="active-text">${message.text.substring(0, 500)}...</span>`;
                break;
            case 'stop':
            case 'pause':
                waveContainer.classList.remove('speaking');
                break;
            case 'voices':
                voiceSelect.innerHTML = '';
                message.voices.forEach(name => {
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    voiceSelect.appendChild(opt);
                });
                break;
        }
    });

    // Signal ready
    vscode.postMessage({ command: 'ready' });
}());
