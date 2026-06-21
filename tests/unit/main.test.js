// Unit tests for js/main.js -> initScrollReveal()
// jsdom has no IntersectionObserver, so we inject a controllable fake and assert behaviour.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initScrollReveal, initBackToTop } from '../../js/main.js';

// A fake IntersectionObserver that records observe/unobserve calls and lets the
// test manually fire the callback with chosen entries.
function makeFakeIO() {
  const instances = [];
  class FakeIO {
    constructor(cb, options) {
      this.cb = cb;
      this.options = options;
      this.observed = [];
      this.unobserved = [];
      instances.push(this);
    }
    observe(el) { this.observed.push(el); }
    unobserve(el) { this.unobserved.push(el); }
    disconnect() {}
    // helper: simulate the browser firing intersections
    fire(entries) { this.cb(entries, this); }
  }
  return { FakeIO, instances };
}

describe('initScrollReveal', () => {
  let fake;

  beforeEach(() => {
    document.body.innerHTML = '';
    fake = makeFakeIO();
    vi.stubGlobal('IntersectionObserver', fake.FakeIO);
    // initScrollReveal reads IntersectionObserver off `window` (the IIFE's `global`).
    window.IntersectionObserver = fake.FakeIO;
  });

  it('creates an observer with the expected options', () => {
    initScrollReveal(document);
    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0].options).toEqual({ root: null, rootMargin: '0px', threshold: 0.1 });
  });

  it('observes every .target-observe element and nothing else', () => {
    document.body.innerHTML = `
      <div class="target-observe" id="a"></div>
      <div class="target-observe" id="b"></div>
      <div class="not-observed" id="c"></div>`;
    initScrollReveal(document);
    const ids = fake.instances[0].observed.map(el => el.id);
    expect(ids).toEqual(['a', 'b']);
  });

  it('adds .is-visible and unobserves an element once it intersects', () => {
    document.body.innerHTML = `<div class="target-observe" id="a"></div>`;
    initScrollReveal(document);
    const el = document.getElementById('a');
    fake.instances[0].fire([{ isIntersecting: true, target: el }]);
    expect(el.classList.contains('is-visible')).toBe(true);
    expect(fake.instances[0].unobserved).toContain(el);
  });

  it('does NOT reveal an element that is not yet intersecting', () => {
    document.body.innerHTML = `<div class="target-observe" id="a"></div>`;
    initScrollReveal(document);
    const el = document.getElementById('a');
    fake.instances[0].fire([{ isIntersecting: false, target: el }]);
    expect(el.classList.contains('is-visible')).toBe(false);
    expect(fake.instances[0].unobserved).not.toContain(el);
  });

  it('handles a page with zero target elements without throwing', () => {
    expect(() => initScrollReveal(document)).not.toThrow();
    expect(fake.instances[0].observed).toHaveLength(0);
  });

  it('processes a mixed batch of entries independently', () => {
    document.body.innerHTML = `
      <div class="target-observe" id="a"></div>
      <div class="target-observe" id="b"></div>`;
    initScrollReveal(document);
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    fake.instances[0].fire([
      { isIntersecting: true, target: a },
      { isIntersecting: false, target: b },
    ]);
    expect(a.classList.contains('is-visible')).toBe(true);
    expect(b.classList.contains('is-visible')).toBe(false);
  });
});

describe('initBackToTop', () => {
  // A fake window that lets the test drive scroll position and capture handlers.
  function makeWin() {
    const handlers = {};
    return {
      scrollY: 0,
      scrolledTo: null,
      addEventListener: (evt, fn) => { handlers[evt] = fn; },
      scrollTo: function (opts) { this.scrolledTo = opts; },
      _fire: (evt) => handlers[evt] && handlers[evt](),
    };
  }

  beforeEach(() => {
    document.body.innerHTML = `<button id="backToTop"></button>`;
  });

  it('returns null and no-ops when the button is absent', () => {
    document.body.innerHTML = '';
    expect(initBackToTop(document, makeWin())).toBeNull();
  });

  it('keeps the button hidden while scroll is below the threshold', () => {
    const win = makeWin();
    win.scrollY = 100;
    initBackToTop(document, win, 400);
    expect(document.getElementById('backToTop').classList.contains('is-shown')).toBe(false);
  });

  it('shows the button once scrolled past the threshold', () => {
    const win = makeWin();
    initBackToTop(document, win, 400);
    win.scrollY = 500;
    win._fire('scroll');
    expect(document.getElementById('backToTop').classList.contains('is-shown')).toBe(true);
  });

  it('smooth-scrolls to the top when clicked', () => {
    const win = makeWin();
    initBackToTop(document, win, 400);
    document.getElementById('backToTop').click();
    expect(win.scrolledTo).toEqual({ top: 0, behavior: 'smooth' });
  });
});
