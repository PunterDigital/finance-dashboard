import type { Page } from '@playwright/test';
import { expect, test } from './app';

// Nothing sticks out sideways: the page doesn't scroll horizontally and no control is cut off.
// Wide tables scroll on their own (`.tbl-scroll`), so the controls in their rows don't count.
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector('.main')!.getBoundingClientRect();
    const clipped = [...document.querySelectorAll('.main button, .main input, .main select, [data-testid="sort-card"]')]
      .filter((el) => !el.closest('.tbl-scroll'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && (r.left < main.left - 1 || r.right > main.right + 1)).length;
    return { scroll: doc.scrollWidth - doc.clientWidth, clipped };
  });
  expect(overflow).toEqual({ scroll: 0, clipped: 0 });
}

// The page column is centred right of the sidebar and grows on wide windows (#3387).
test('the page column is centred and widens on big windows; nothing overflows at the minimum size', async ({ app, page }) => {
  const month = new Date().toISOString().slice(0, 7);
  await page.evaluate(async (m) => {
    const post = (url: string, body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post('/api/accounts', { name: 'E2E Current', type: 'Personal', base_currency: 'CZK' });
    await post('/api/transactions', { date: `${m}-01`, description: 'Groceries', account: 'E2E Current', amount: -1600, currency: 'CZK', type: 'Expense' });
  }, month);
  await page.reload();
  await page.getByRole('navigation').getByRole('link', { name: /Sort need\/want/ }).click();
  const card = page.getByTestId('sort-card');
  await expect(card).toContainText('Groceries');

  // The minimum window: a real resize, since the OS enforces minWidth.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(900);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('link', { name: 'Transactions', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Groceries' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // 4K, emulated (a real window can't outgrow the CI screen). Last in the test: emulation can't be undone.
  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.getByRole('navigation').getByRole('link', { name: /Sort need\/want/ }).click();
  await expect(card).toBeVisible();
  const geo = await page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const main = r('.main'), inner = r('.main-inner'), card = r('[data-testid="sort-card"]');
    const pad = parseFloat(getComputedStyle(document.querySelector('.main')!).paddingLeft);
    return {
      innerWidth: inner.width,
      leftGap: inner.left - main.left - pad,
      rightGap: main.right - pad - inner.right,
      cardWidth: card.width,
      cardOffCentre: Math.abs((card.left + card.right) / 2 - (inner.left + inner.right) / 2),
    };
  });
  expect(geo.innerWidth).toBe(1760);
  expect(geo.leftGap).toBeGreaterThan(100);
  expect(Math.abs(geo.leftGap - geo.rightGap)).toBeLessThanOrEqual(1);
  expect(geo.cardWidth).toBe(540);
  expect(geo.cardOffCentre).toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);
});
