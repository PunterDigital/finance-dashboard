import { expect, test } from './app';

// Made-up accounts and rows, in CZK so nothing needs an FX rate.
test('two transfer rows auto-match; the pair can be flipped, unlinked and linked by hand', async ({ page }) => {
  await page.evaluate(async () => {
    const post = (url: string, body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post('/api/accounts', { name: 'E2E Current', type: 'Personal', base_currency: 'CZK' });
    await post('/api/accounts', { name: 'E2E Savings', type: 'Personal', base_currency: 'CZK' });
    await post('/api/transactions', { date: '2026-10-10', description: 'Transfer to savings', account: 'E2E Current', amount: 5000, currency: 'CZK', type: 'Transfer' });
    await post('/api/transactions', { date: '2026-10-10', description: 'Incoming payment', account: 'E2E Savings', amount: 5000, currency: 'CZK', type: 'Transfer' });
  });

  await page.getByRole('navigation').getByRole('link', { name: 'Transfers' }).click();
  const summary = page.locator('.page-head .sub');
  await expect(summary).toHaveText('0 matched pairs · 2 unpaired rows (2 unresolved — excluded from balances)');
  const pairs = page.locator('.card', { has: page.getByRole('heading', { name: 'Matched pairs' }) }).locator('tbody tr');
  const unpaired = page.locator('.card', { has: page.getByRole('heading', { name: /Unpaired rows/ }) }).locator('tbody tr');
  await expect(pairs).toHaveText(['No pairs yet — run auto-match.']);

  // "Transfer to …" marks the sending side.
  await page.getByRole('button', { name: '⇄ Auto-match' }).click();
  await expect(page.getByText('Matched 1 pairs (0 cross-currency) · 0 rows left unpaired')).toBeVisible();
  await expect(summary).toHaveText('1 matched pairs · 0 unpaired rows');
  await expect(pairs).toHaveCount(1);
  await expect(pairs.locator('td').nth(0)).toHaveText('10 Oct 2026');
  await expect(pairs.locator('td').nth(1)).toHaveText('E2E Current');
  await expect(pairs.locator('td').nth(4)).toHaveText('E2E Savings');
  await expect(unpaired).toHaveText(['Everything is paired 🎉']);

  await pairs.getByRole('button', { name: '⇄ Flip' }).click();
  await expect(pairs.locator('td').nth(1)).toHaveText('E2E Savings');
  await expect(pairs.locator('td').nth(4)).toHaveText('E2E Current');

  await pairs.getByRole('button', { name: 'Unlink' }).click();
  await expect(summary).toHaveText('0 matched pairs · 2 unpaired rows (2 unresolved — excluded from balances)');
  await expect(pairs).toHaveText(['No pairs yet — run auto-match.']);
  await expect(unpaired).toHaveCount(2);

  // Link by hand: the current account sends to savings.
  const current = unpaired.filter({ has: page.getByRole('cell', { name: 'E2E Current', exact: true }) });
  const counterpart = current.getByRole('combobox').nth(1);
  const savingsOption = await counterpart.evaluate((el: HTMLSelectElement) => [...el.options].find((o) => o.text.includes('E2E Savings'))!.text);
  expect(savingsOption).toMatch(/^2026-10-10 · E2E Savings · 5.000[.,]00 CZK$/);
  await counterpart.selectOption({ label: savingsOption });
  await current.getByRole('button', { name: 'Send →' }).click();
  await expect(page.getByText('Linked', { exact: true })).toBeVisible();
  await expect(summary).toHaveText('1 matched pairs · 0 unpaired rows');
  await expect(pairs.locator('td').nth(1)).toHaveText('E2E Current');
  await expect(pairs.locator('td').nth(4)).toHaveText('E2E Savings');

  const rows = await page.evaluate(async () => (await (await fetch('/api/transactions')).json()).rows);
  const role = (account: string) => rows.find((t: any) => t.account === account).transfer_role;
  expect([role('E2E Current'), role('E2E Savings')]).toEqual(['out', 'in']);
});
