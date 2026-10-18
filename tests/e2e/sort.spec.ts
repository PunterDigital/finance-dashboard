import type { Page } from '@playwright/test';
import { expect, test } from './app';

// Drags the sort card sideways with real pointer events, in steps like a hand would.
async function dragCard(page: Page, dx: number) {
  const box = (await page.getByTestId('sort-card').boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y);
  await page.mouse.up();
}

// Made-up CZK rows in the current month, so the dashboard shows them and nothing needs an FX rate.
test('sort expenses into need and want with keys, buttons and drags; totals follow', async ({ page }) => {
  const month = new Date().toISOString().slice(0, 7);
  await page.evaluate(async (m) => {
    const post = (url: string, body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post('/api/accounts', { name: 'E2E Current', type: 'Personal', base_currency: 'CZK' });
    const tx = (day: string, description: string, amount: number, type = 'Expense') =>
      post('/api/transactions', { date: `${m}-${day}`, description, account: 'E2E Current', amount, currency: 'CZK', type });
    await tx('01', 'Rent', -15000);
    await tx('02', 'Cinema', -400);
    await tx('03', 'Groceries', -1600);
    await tx('04', 'Streaming', -299);
    await tx('05', 'Salary', 60000, 'Income');
  }, month);
  await page.reload();

  const navLink = page.getByRole('navigation').getByRole('link', { name: /Sort need\/want/ });
  await expect(navLink).toContainText('4');
  await navLink.click();

  const remaining = page.getByTestId('sort-remaining');
  const card = page.getByTestId('sort-card');
  await expect(remaining).toHaveText('4 unsorted expenses');

  // Newest first. ← is want, → is need; presses straight after each other all count.
  await expect(card).toContainText('Streaming');
  await expect(card).toContainText('299.00 CZK');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await expect(card).toContainText('Cinema');
  await expect(remaining).toHaveText('2 unsorted expenses');
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(card).toContainText('Rent');
  await page.getByRole('button', { name: 'Need →' }).click();
  await expect(page.getByTestId('sort-done')).toContainText('1 skipped');
  await expect(remaining).toHaveText('1 unsorted expense · 1 skipped');

  // Undo brings Rent back; a drag to the right marks it need again.
  await page.getByRole('button', { name: '↶ Undo' }).click();
  await expect(card).toContainText('Rent');
  await expect(remaining).toHaveText('2 unsorted expenses · 1 skipped');
  await dragCard(page, 220);
  await expect(page.getByTestId('sort-done')).toBeVisible();

  // The skipped one comes back for review; a drag to the left marks it want. A short drag does nothing.
  await page.getByRole('button', { name: 'Review skipped' }).click();
  await expect(card).toContainText('Cinema');
  await dragCard(page, -40);
  await expect(card).toContainText('Cinema');
  await dragCard(page, -220);
  await expect(page.getByTestId('sort-done')).toContainText('All expenses are sorted');
  await expect(remaining).toHaveText('0 unsorted expenses');
  await expect(navLink).toHaveText('Sort need/want');

  // Dashboard split: need = Rent + Groceries, want = Cinema + Streaming.
  await page.getByRole('navigation').getByRole('link', { name: 'Dashboard' }).click();
  const split = page.getByTestId('need-want');
  await expect(split.getByTestId('need-total')).toHaveText('16,600 Kč');
  await expect(split.getByTestId('want-total')).toHaveText('699 Kč');
  await expect(split).toContainText('(96.0%)');
  await expect(split).toContainText('(4.0%)');

  // Transactions: filter by want, then change one inline.
  await page.getByRole('navigation').getByRole('link', { name: 'Transactions' }).click();
  await page.getByRole('combobox', { name: 'Need/want' }).selectOption('want');
  const rows = page.locator('.tbl tbody tr');
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: 'Cinema' }).getByRole('combobox', { name: 'Need or want: Cinema' }).selectOption('need');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Streaming');

  const stored = await page.evaluate(async () => (await (await fetch('/api/transactions')).json()).rows);
  const by = (d: string) => stored.find((t: any) => t.description === d).necessity;
  expect([by('Rent'), by('Groceries'), by('Cinema'), by('Streaming'), by('Salary')]).toEqual(['need', 'need', 'need', 'want', null]);
});
