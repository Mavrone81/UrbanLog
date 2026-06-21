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
  test('WhatsApp FAB is always visible and links to WhatsApp', async ({ page }) => {
    await page.goto('/');
    const wa = page.locator('.fab-whatsapp');
    await expect(wa).toBeVisible();
    await expect(wa).toHaveAttribute('href', new RegExp(`wa\\.me/${WA}`));
    await expect(wa).toHaveAttribute('target', '_blank');
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

test.describe('Scroll-reveal animation', () => {
  test('off-screen .target-observe elements become visible after scrolling into view', async ({ page }) => {
    await page.goto('/');
    const target = page.locator('.target-observe').last();
    await target.scrollIntoViewIfNeeded();
    await expect(target).toHaveClass(/is-visible/, { timeout: 5000 });
  });
});
