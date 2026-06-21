// Chat widget: talks to the server-side Claude proxy at /api/chat.
// The API key lives only on the server; the browser never sees it.
(function () {
    const launcher = document.getElementById('chatLauncher');
    const panel = document.getElementById('chatPanel');
    const closeBtn = document.getElementById('chatClose');
    const form = document.getElementById('chatForm');
    const input = document.getElementById('chatText');
    const sendBtn = document.getElementById('chatSend');
    const messagesEl = document.getElementById('chatMessages');
    if (!launcher || !panel || !form) return;

    const ENDPOINT = '/api/chat';
    const history = [];          // real user/assistant turns sent to the API
    let greeted = false;

    function escapeHtml(s) {
        return s.replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    // Escape first, then linkify only safe URL / tel / mailto patterns.
    function render(text) {
        let html = escapeHtml(text);
        html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
        html = html.replace(/(^|\s)(\+?\d[\d\s]{6,}\d)/g, (m, pre, num) =>
            `${pre}<a href="tel:${num.replace(/\s/g, '')}">${num}</a>`);
        html = html.replace(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '<a href="mailto:$1">$1</a>');
        return html;
    }

    function addMessage(role, text) {
        const el = document.createElement('div');
        el.className = 'chat-msg ' + (role === 'user' ? 'user' : 'bot');
        el.innerHTML = render(text);
        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return el;
    }

    // Prominent WhatsApp button (booking confirmation or human hand-off).
    function addWhatsAppCta(url, label) {
        if (!/^https:\/\/wa\.me\//.test(url || '')) return;
        const a = document.createElement('a');
        a.className = 'chat-cta';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = '<i class="ph ph-whatsapp-logo"></i> ' + (label || 'Chat on WhatsApp');
        messagesEl.appendChild(a);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Download-quotation (PDF) button.
    function addPdfCta(url) {
        if (typeof url !== 'string' || !url) return;
        const a = document.createElement('a');
        a.className = 'chat-cta pdf';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = '<i class="ph ph-file-pdf"></i> Download quotation (PDF)';
        messagesEl.appendChild(a);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function openPanel() {
        panel.hidden = false;
        if (!greeted) {
            addMessage('bot', "Hi! 👋 I'm the Urban Werkz assistant. Ask me about our delivery services, or I can point you to WhatsApp for a quote.");
            greeted = true;
        }
        input.focus();
    }
    function closePanel() { panel.hidden = true; }

    launcher.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
    closeBtn.addEventListener('click', closePanel);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;

        addMessage('user', text);
        history.push({ role: 'user', content: text });
        input.value = '';
        input.disabled = sendBtn.disabled = true;

        const typing = addMessage('bot', 'Typing…');
        typing.classList.add('typing');

        try {
            const res = await fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: history }),
            });
            const data = await res.json().catch(() => ({}));
            typing.remove();

            if (!res.ok) {
                addMessage('bot', data.error || 'Sorry, something went wrong. Please WhatsApp us at +65 8996 8390.');
            } else {
                addMessage('bot', data.reply);
                history.push({ role: 'assistant', content: data.reply });
                if (data.whatsappUrl) addWhatsAppCta(data.whatsappUrl, data.whatsappLabel);
                if (data.quote && data.quote.pdfUrl) addPdfCta(data.quote.pdfUrl);
            }
        } catch (err) {
            typing.remove();
            addMessage('bot', "I couldn't reach the server. Please WhatsApp us at +65 8996 8390.");
        } finally {
            input.disabled = sendBtn.disabled = false;
            input.focus();
        }
    });
})();
