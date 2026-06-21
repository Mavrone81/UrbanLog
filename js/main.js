// Scroll-reveal: reveal elements with `.target-observe` once when they enter the viewport.
// Logic is wrapped in a named, exported function so it can be unit-tested in isolation
// (the browser still auto-initialises on DOMContentLoaded — behaviour is unchanged).
(function (global) {
    function initScrollReveal(doc) {
        doc = doc || global.document;

        const observerOptions = {
            root: null,
            rootMargin: '0px',
            threshold: 0.1
        };

        const observer = new global.IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-visible');
                    obs.unobserve(entry.target);
                }
            });
        }, observerOptions);

        doc.querySelectorAll('.target-observe').forEach(el => observer.observe(el));

        return observer;
    }

    // Back-to-top floating button: reveal it after the user scrolls past a threshold,
    // and smooth-scroll to the top when clicked.
    function initBackToTop(doc, win, threshold) {
        doc = doc || global.document;
        win = win || global;
        threshold = threshold || 400;

        const btn = doc.getElementById('backToTop');
        if (!btn) return null;

        const toggle = () => {
            const y = win.scrollY || doc.documentElement.scrollTop || 0;
            btn.classList.toggle('is-shown', y > threshold);
        };

        win.addEventListener('scroll', toggle, { passive: true });
        btn.addEventListener('click', () => win.scrollTo({ top: 0, behavior: 'smooth' }));
        toggle();

        return btn;
    }

    // Auto-initialise in the browser.
    if (global.document && typeof global.document.addEventListener === 'function') {
        global.document.addEventListener('DOMContentLoaded', () => {
            initScrollReveal();
            initBackToTop();
        });
    }

    // Expose for tests (CommonJS) and browser global, without breaking either environment.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { initScrollReveal, initBackToTop };
    } else {
        global.initScrollReveal = initScrollReveal;
        global.initBackToTop = initBackToTop;
    }
})(typeof window !== 'undefined' ? window : globalThis);
