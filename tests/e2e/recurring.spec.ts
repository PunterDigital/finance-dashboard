import { expect, test } from './app';

// Made-up CZK rows, so nothing needs an FX rate. Dates count back from today so the
// statuses don't depend on when the test runs.
test('recurring: a price change stays one item, and a missed payment shows as maybe stopped', async ({ page }) => {
  await page.evaluate(async () => {
    const post = (url: string, body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const monthsAgo = (n: number, day: number) => {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - n);
      d.setUTCDate(day);
      return d.toISOString().slice(0, 10);
    };
    await post('/api/accounts', { name: 'E2E Current', type: 'Personal', base_currency: 'CZK' });
    const tx = (date: string, description: string, amount: number) =>
      post('/api/transactions', { date, description, account: 'E2E Current', amount, currency: 'CZK', type: 'Expense' });
    // Streaming: 199 for four months, then 249 for the last two (the latest one this month).
    for (const n of [5, 4, 3, 2]) await tx(monthsAgo(n, 1), 'Streamy', -199);
    for (const n of [1, 0]) await tx(monthsAgo(n, 1), 'Streamy', -249);
    // Gym: paid monthly until four months ago, then nothing.
    for (const n of [8, 7, 6, 5, 4]) await tx(monthsAgo(n, 3), 'Gym Club', -900);
  });

  await page.getByRole('navigation').getByRole('link', { name: /Recurring/ }).click();
  await page.getByRole('button', { name: /Detect recurring/ }).click();
  await expect(page.getByText(/Detection complete: 2 recurring patterns/)).toBeVisible();

  const streamy = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Streamy', exact: true }) });
  await expect(streamy).toHaveCount(1);
  await expect(streamy.getByTestId('price-change')).toHaveText(/Price changed from \D*199\D00 to \D*249\D00 on/);
  await expect(streamy).toContainText('6×');
  await expect(streamy).not.toContainText('maybe stopped');

  const gym = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Gym Club', exact: true }) });
  await expect(gym).toContainText('missed, maybe stopped');
  await expect(gym.getByTestId('price-change')).toHaveCount(0);
});
