// Pulls live content from the CMS (/cms/site) and applies it over the static defaults.
// Progressive enhancement: if the CMS is unreachable, the hardcoded page content stands.
(function () {
    fetch('/cms/site', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then(apply)
        .catch(() => {});

    function setText(key, val) {
        if (val == null) return;
        document.querySelectorAll('[data-cms="' + key + '"]').forEach((el) => { el.textContent = val; });
    }

    // Replace the on-page FAQ + its FAQPage structured data with CMS-managed entries.
    function renderFaq(faq) {
        const list = document.querySelector('.faq-list');
        if (list) {
            list.innerHTML = '';
            faq.forEach((item) => {
                if (!item || !item.q || !item.a) return;
                const det = document.createElement('details');
                det.className = 'faq-item';
                const sum = document.createElement('summary');
                sum.textContent = item.q;
                const p = document.createElement('p');
                p.textContent = item.a;
                det.appendChild(sum);
                det.appendChild(p);
                list.appendChild(det);
            });
        }
        const ld = {
            '@context': 'https://schema.org', '@type': 'FAQPage',
            mainEntity: faq.filter((f) => f && f.q && f.a).map((f) => ({
                '@type': 'Question', name: f.q,
                acceptedAnswer: { '@type': 'Answer', text: f.a },
            })),
        };
        let s = [...document.querySelectorAll('script[type="application/ld+json"]')].find((x) => x.textContent.includes('FAQPage'));
        if (!s) { s = document.createElement('script'); s.type = 'application/ld+json'; document.head.appendChild(s); }
        s.textContent = JSON.stringify(ld);
    }

    function apply(d) {
        if (!d) return;
        const c = d.content || {};
        const seo = d.seo || {};

        if (seo.title) document.title = seo.title;
        if (seo.description) {
            const m = document.querySelector('meta[name="description"]');
            if (m) m.setAttribute('content', seo.description);
        }
        if (seo.keywords) {
            const k = document.querySelector('meta[name="keywords"]');
            if (k) k.setAttribute('content', seo.keywords);
        }
        if (Array.isArray(d.faq) && d.faq.length) renderFaq(d.faq);

        setText('heroTitleTop', c.heroTitleTop);
        setText('heroTitleBottom', c.heroTitleBottom);
        setText('heroSubtitle', c.heroSubtitle);
        setText('availability', c.availability);
        setText('phone', c.phone);

        if (c.whatsapp && /^\d{6,}$/.test(c.whatsapp)) {
            document.querySelectorAll('a[href*="wa.me/"]').forEach((a) => {
                a.href = a.href.replace(/wa\.me\/\d+/, 'wa.me/' + c.whatsapp);
            });
            document.querySelectorAll('a[href^="tel:"]').forEach((a) => { a.href = 'tel:+' + c.whatsapp; });
        }
        if (c.email) {
            document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
                const q = a.href.indexOf('?');
                a.href = 'mailto:' + c.email + (q >= 0 ? a.href.slice(q) : '');
            });
        }
        if (d.logoUrl) {
            const link = document.querySelector('link[rel="icon"]');
            if (link) link.href = d.logoUrl;
        }
    }
})();
