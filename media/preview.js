(function() {
    const ws = new WebSocket('ws://127.0.0.1:3001');
    let lastHighlighted = null;

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.command === 'sentenceChanged') {
            const chapter = message.chapter;
            if (chapter && typeof chapter.lineStart === 'number') {
                highlightLine(chapter.lineStart);
            }
        }
    };

    function highlightLine(line) {
        // Remove old highlight
        if (lastHighlighted) {
            lastHighlighted.classList.remove('ra-active-line');
        }

        // The markdown-it plugin attaches data-line to paragraphs and headings
        const element = document.querySelector(`[data-line="${line}"]`);
        if (element) {
            element.classList.add('ra-active-line');
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            lastHighlighted = element;
        }
    }
})();
