# UrbanLog — Testing Guide

Test suite for the **Urban Werkz Delivery** marketing site (`urbanfleetsg.com`).

The app is a **vanilla static site** — `index.html`, `css/style.css`, `js/main.js`, served by `nginx`. There is **no backend, database, queue, or authentication**. The test strategy is scoped accordingly: the testable surface is one JavaScript behaviour (scroll-reveal), the HTTP file-serving layer, the link/asset contracts, and the user journeys that convert a visitor into a WhatsApp conversation.

| Layer | Tool | What it covers | Run |
|-------|------|----------------|-----|
| Unit | [Vitest](https://vitest.dev) + jsdom | every function in `js/main.js` | `npm run test:unit` |
| Integration | Vitest + Node `http`/`fs` | static-file serving, asset & link integrity | `npm run test:integration` |
| E2E | [Playwright](https://playwright.dev) | full user journeys in real browsers | `npm run test:e2e` |

Current status: **38 tests passing** (24 Vitest + 14 Playwright). Unit coverage of `js/main.js`: **100% functions**.

---

## 1. Unit testing — every function

**Tooling:** Vitest with the `jsdom` environment. jsdom does not implement `IntersectionObserver`, so the tests inject a controllable fake that records `observe`/`unobserve` calls and lets the test fire intersection callbacks deterministically. External dependency (the browser observer API) is fully mocked.

**File:** `tests/unit/main.test.js` — target: `js/main.js → initScrollReveal(doc)`

`main.js` was refactored into a single named, exported function `initScrollReveal()` (the browser still auto-initialises on `DOMContentLoaded`; behaviour is unchanged).

| Function | Test case | Asserts |
|----------|-----------|---------|
| `initScrollReveal` | creates observer with expected options | observer built once with `{root:null, rootMargin:'0px', threshold:0.1}` |
| `initScrollReveal` | observes every `.target-observe`, nothing else | only the two tagged elements are observed |
| `initScrollReveal` | element intersects | adds `.is-visible` **and** calls `unobserve` (reveal-once) |
| `initScrollReveal` | element not yet intersecting | does **not** add `.is-visible`, does **not** unobserve |
| `initScrollReveal` | page with zero targets | does not throw; observes nothing (edge case) |
| `initScrollReveal` | mixed batch of entries | intersecting → revealed, non-intersecting → untouched, independently |
| `initBackToTop` | button absent | returns `null`, no-ops |
| `initBackToTop` | scroll below threshold | back-to-top button stays hidden (no `.is-shown`) |
| `initBackToTop` | scroll past threshold | button gains `.is-shown` |
| `initBackToTop` | click | calls `scrollTo({top:0, behavior:'smooth'})` |

---

## 2. Integration testing — connections

There are no internal APIs/DB to integrate. The real "connections" are: the **HTTP server** that delivers files (nginx in prod; an equivalent Node static server in test), the **local assets** referenced by the page, and the **external link contracts** (WhatsApp deep links, CDN resources). The test spins up a throwaway static server over the actual repo files and exercises them.

**File:** `tests/integration/site.test.js`

| Connection / endpoint | Test case | Asserts |
|-----------------------|-----------|---------|
| `GET /` | serves landing page | `200`, `content-type: text/html`, body has `<title>Urban Werkz Delivery` |
| `GET /css/style.css` | serves stylesheet | `200`, css content-type |
| `GET /js/main.js` | serves script | `200`, body contains `initScrollReveal` |
| `GET /does-not-exist.html` | missing path | `404` (validation/error path) |
| local assets | every `css/`+`js/` ref in `index.html` exists on disk | no broken local references |
| WhatsApp links | every `wa.me/<n>` link | matches `^65\d{8}$` and equals the published number `6589968390` |
| external links | every absolute `href`/`src` | uses `https://` (no mixed content) |

> Note: external CDN/WhatsApp **reachability** is intentionally *not* network-tested here (would be flaky/offline-dependent). We test the **contract** (URL shape) instead. A separate, optional reachability check can be added behind a `NETWORK=1` flag if desired.

---

## 3. End-to-end testing — user workflows

**Tooling:** Playwright, two projects — `chromium` (desktop) and `mobile-safari` (iPhone 13 viewport). A disposable static server (`python3 -m http.server`) serves the repo; Playwright drives a real browser against it.

**File:** `tests/e2e/userflows.spec.js`

| Workflow | Steps / asserts |
|----------|-----------------|
| **Landing** | load `/` → title matches `Urban Werkz Delivery`, hero tagline visible |
| **Get a quote (hero)** | "Get Instant Quote" CTA visible → `href` matches `wa.me/6589968390`, `target=_blank` |
| **Get a quote (service cards)** | ≥4 "Get Quote" buttons → each `href` contains `wa.me/6589968390` and a prefilled `text=` message |
| **Become a driver** | "Driver Partner Sign Up" → `href` matches `wa.me/6589968390...driver` |
| **Direct contact** | phone link → `wa.me/6589968390`; visible number reads `8996 8390` |
| **Floating WhatsApp FAB** | always visible → links to `wa.me/6589968390`, opens new tab |
| **Floating back-to-top FAB** | hidden at top → appears after scrolling → click returns to top |
| **Scroll-reveal** | scroll an off-screen `.target-observe` into view → it gains `.is-visible` |

Failure/recovery paths covered: the 404 path (integration), the "not intersecting" non-reveal (unit), and the no-targets edge case (unit). There is no auth/payment/error UI in the app to recover from.

---

## How to run

### Locally
```bash
npm install                 # one-time: installs Vitest, jsdom, Playwright
npx playwright install      # one-time: download browser binaries (E2E only)

npm run test:unit           # unit only
npm run test:integration    # integration only
npm test                    # unit + integration (Vitest)
npm run coverage            # Vitest with coverage report (coverage/index.html)
npm run test:e2e            # Playwright E2E (all projects)
npm run test:all            # everything
```

### In CI (GitHub Actions example)
```yaml
name: tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test                       # unit + integration
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e -- --project=chromium
```

> The server-side auto-deploy (`/root/auto-deploy-urbanlog.sh`) rebuilds the container on every push to `main`. To gate deploys on green tests, add a `git diff`-aware test step to that script, or switch to the CI workflow above as the deploy trigger.

---

## Coverage summary & gaps

| Metric (`js/main.js`) | Value |
|-----------------------|-------|
| Statements | 94.87% |
| Functions | 100% |
| Branches | 66.66% |
| Lines | 94.87% |

**Known gaps (with reasons):**
- **Lines 37–38** (`else { global.initScrollReveal = ... }`) — the browser-global export branch. Not executed under the CommonJS test runner because `module.exports` is defined there. It *is* exercised in the browser and indirectly validated by the E2E scroll-reveal test. Low risk; left uncovered deliberately.
- **`DOMContentLoaded` auto-init wiring** — covered behaviourally by E2E (the page actually reveals on scroll) rather than by a unit test, since it depends on real browser lifecycle.
- **No HTML/CSS visual-regression tests** — out of scope for this content site; could add Playwright screenshot snapshots later if the design stabilises.
- **External resource reachability** (Google Fonts, Phosphor icons CDN) — not asserted to avoid network flakiness; only URL correctness is checked.
