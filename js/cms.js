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

    function apply(d) {
        if (!d) return;
        const c = d.content || {};
        const seo = d.seo || {};

        if (seo.title) document.title = seo.title;
        if (seo.description) {
            const m = document.querySelector('meta[name="description"]');
            if (m) m.setAttribute('content', seo.description);
        }

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
