// End-to-end user-journey tests (Playwright) against the served site.
import { test, expect } from '@playwright/test';

const WA = '6589968390';

test.describe('Landing page loads', () => {
  test('shows the brand, hero headline and tagline', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Urban Werkz Delivery/);
    await expect(page.locator('.hero-subtitle')).toBeVisible();
  });
});

test.describe('Primary conversion flow — request a quote', () => {
  test('hero "Get Instant Quote" points to the correct WhatsApp deep link in a new tab', async ({ page }) => {
    await page.goto('/');
    const cta = page.getByRole('link', { name: /Get Instant Quote/i });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', new RegExp(`wa\\.me/${WA}`));
    await expect(cta).toHaveAttribute('target', '_blank');
  });

  test('every service card "Get Quote" button links to WhatsApp with a service-specific message', async ({ page }) => {
    await page.goto('/');
    const quoteButtons = page.getByRole('link', { name: /Get Quote/i });
    const count = await quoteButtons.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < count; i++) {
      const href = await quoteButtons.nth(i).getAttribute('href');
      expect(href).toContain(`wa.me/${WA}`);
      expect(href).toContain('text='); // carries a prefilled quote message
    }
  });
});

test.describe('Driver-partner recruitment flow', () => {
  test('"Driver Partner Sign Up" opens WhatsApp with the driver-interest message', async ({ page }) => {
    await page.goto('/');
    const link = page.getByRole('link', { name: /Driver Partner Sign Up/i });
    await expect(link).toHaveAttribute('href', new RegExp(`wa\\.me/${WA}.*driver`, 'i'));
  });
});

test.describe('Direct contact flow', () => {
  test('the phone number links to WhatsApp', async ({ page }) => {
    await page.goto('/');
    const phone = page.locator('a.phone-link');
    await expect(phone).toHaveAttribute('href', new RegExp(`wa\\.me/${WA}`));
    await expect(page.locator('.phone-number')).toContainText('8996 8390');
  });
});

test.describe('Floating action buttons', () => {
  test('Call FAB dials the website number', async ({ page }) => {
    await page.goto('/');
    const call = page.locator('.fab-call');
    await expect(call).toBeVisible();
    await expect(call).toHaveAttribute('href', `tel:+${WA}`);
  });

  test('WhatsApp FAB is always visible and links to WhatsApp', async ({ page }) => {
    await page.goto('/');
    const wa = page.locator('.fab-whatsapp');
    await expect(wa).toBeVisible();
    await expect(wa).toHaveAttribute('href', new RegExp(`wa\\.me/${WA}`));
    await expect(wa).toHaveAttribute('target', '_blank');
  });

  test('Email FAB opens a mailto to the support address', async ({ page }) => {
    await page.goto('/');
    const email = page.locator('.fab-email');
    await expect(email).toBeVisible();
    await expect(email).toHaveAttribute('href', /^mailto:Urbanfleet@gmail\.com/i);
  });

  test('favicon link points to the PNG icon', async ({ page }) => {
    await page.goto('/');
    const icon = page.locator('link[rel="icon"]');
    await expect(icon).toHaveAttribute('href', 'favicon.png');
  });

  test('back-to-top FAB is hidden at the top and appears after scrolling', async ({ page }) => {
    await page.goto('/');
    const top = page.locator('#backToTop');
    await expect(top).not.toHaveClass(/is-shown/);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect(top).toHaveClass(/is-shown/);
    await top.click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(50);
  });
});

test.describe('Chat widget', () => {
  test('panel is hidden until the launcher is clicked, then shows a greeting', async ({ page }) => {
    await page.goto('/');
    const panel = page.locator('#chatPanel');
    await expect(panel).toBeHidden();
    await page.locator('#chatLauncher').click();
    await expect(panel).toBeVisible();
    await expect(page.locator('.chat-msg.bot').first()).toContainText(/Urban Werkz assistant/i);
    await page.locator('#chatClose').click();
    await expect(panel).toBeHidden();
  });

  test('sending a message posts to /api/chat and renders the reply', async ({ page }) => {
    // The static test server has no backend, so stub the proxy endpoint.
    await page.route('**/api/chat', (route) =>
      route.fulfill({ json: { reply: 'We deliver same-day across Singapore!' } }));
    await page.goto('/');
    await page.locator('#chatLauncher').click();
    await page.locator('#chatText').fill('Do you do same-day?');
    await page.locator('#chatSend').click();
    await expect(page.locator('.chat-msg.user').last()).toHaveText('Do you do same-day?');
    await expect(page.locator('.chat-msg.bot').last()).toContainText('same-day across Singapore');
  });

  test('shows a "Chat with our team" WhatsApp button on human hand-off', async ({ page }) => {
    await page.route('**/api/chat', (route) =>
      route.fulfill({ json: { reply: "I'll connect you to our team.", whatsappUrl: `https://wa.me/${WA}?text=hi`, whatsappLabel: 'Chat with our team on WhatsApp' } }));
    await page.goto('/');
    await page.locator('#chatLauncher').click();
    await page.locator('#chatText').fill('I have a complaint');
    await page.locator('#chatSend').click();
    const cta = page.locator('.chat-cta');
    await expect(cta).toContainText('Chat with our team on WhatsApp');
    await expect(cta).toHaveAttribute('href', new RegExp(`wa\\.me/${WA}`));
  });

  test('shows a Download quotation (PDF) button when the bot quotes', async ({ page }) => {
    await page.route('**/api/chat', (route) =>
      route.fulfill({ json: { reply: 'That is SGD 23.53 incl. GST.', quote: { id: 'q_1', total: 23.53, currency: 'SGD', pdfUrl: '/api/quote/q_1.pdf' } } }));
    await page.goto('/');
    await page.locator('#chatLauncher').click();
    await page.locator('#chatText').fill('quote please');
    await page.locator('#chatSend').click();
    const pdf = page.locator('.chat-cta.pdf');
    await expect(pdf).toBeVisible();
    await expect(pdf).toContainText('Download quotation (PDF)');
    await expect(pdf).toHaveAttribute('href', '/api/quote/q_1.pdf');
  });

  test('renders a WhatsApp booking hand-off button when the bot confirms a booking', async ({ page }) => {
    const waUrl = `https://wa.me/${WA}?text=${encodeURIComponent('Hi Urban Werkz, I\'d like to book a delivery:')}`;
    await page.route('**/api/chat', (route) =>
      route.fulfill({ json: { reply: 'Your booking summary is ready!', whatsappUrl: waUrl } }));
    await page.goto('/');
    await page.locator('#chatLauncher').click();
    await page.locator('#chatText').fill('Yes, book it');
    await page.locator('#chatSend').click();
    const cta = page.locator('.chat-cta');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', new RegExp(`wa\\.me/${WA}`));
    await expect(cta).toHaveAttribute('target', '_blank');
  });
});

test.describe('Scroll-reveal animation', () => {
  test('off-screen .target-observe elements become visible after scrolling into view', async ({ page }) => {
    await page.goto('/');
    const target = page.locator('.target-observe').last();
    await target.scrollIntoViewIfNeeded();
    await expect(target).toHaveClass(/is-visible/, { timeout: 5000 });
  });
});
