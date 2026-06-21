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

    // Auto-initialise in the browser.
    if (global.document && typeof global.document.addEventListener === 'function') {
        global.document.addEventListener('DOMContentLoaded', () => initScrollReveal());
    }

    // Expose for tests (CommonJS) and browser global, without breaking either environment.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { initScrollReveal };
    } else {
        global.initScrollReveal = initScrollReveal;
    }
})(typeof window !== 'undefined' ? window : globalThis);
