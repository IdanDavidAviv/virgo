(function () {
    const speechSynth = window.speechSynthesis;
    let utterance = null;

    // Create the UI container
    const container = document.createElement('div');
    container.className = 'tts-floating-controls';

    // Play Button
    const playBtn = document.createElement('button');
    playBtn.innerHTML = '▶ Play';
    playBtn.onclick = () => {
        if (speechSynth.paused) {
            speechSynth.resume();
        } else if (!speechSynth.speaking) {
            // Temporarily hide controls so they aren't read out
            container.style.display = 'none';
            const textToRead = document.body.innerText;
            container.style.display = 'flex';

            utterance = new SpeechSynthesisUtterance(textToRead);
            utterance.rate = 1.0;
            // Best effort voice picking: prioritize host OS default
            speechSynth.speak(utterance);
        }
    };

    // Pause Button
    const pauseBtn = document.createElement('button');
    pauseBtn.innerHTML = '⏸ Pause';
    pauseBtn.onclick = () => {
        if (speechSynth.speaking && !speechSynth.paused) {
            speechSynth.pause();
        }
    };

    // Stop Button
    const stopBtn = document.createElement('button');
    stopBtn.innerHTML = '⏹ Stop';
    stopBtn.onclick = () => {
        speechSynth.cancel();
    };

    container.appendChild(playBtn);
    container.appendChild(pauseBtn);
    container.appendChild(stopBtn);

    // Inject into DOM when ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => document.body.appendChild(container));
    } else {
        document.body.appendChild(container);
    }
})();
