import { expect, test } from './app';

// Made-up CZK rows, so nothing needs an FX rate. Dates count back from today so "maybe stopped"
// doesn't depend on when the test runs.
test('inbox: accept, edit and reject suggestions; their text is plain text', async ({ page }) => {
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
    await post('/api/categories', { name: 'E2E Groceries', type: 'Expense', grp: 'Food' });
    await post('/api/categories', { name: 'E2E Eating out', type: 'Expense', grp: 'Food' });
    await post('/api/categories', { name: 'E2E Fuel', type: 'Expense', grp: 'Car' });
    const tx = (date: string, description: string, amount: number) =>
      post('/api/transactions', { date, description, account: 'E2E Current', amount, currency: 'CZK', type: 'Expense' });
    await tx('2026-05-01', 'Albert', -500);
    await tx('2026-05-02', 'ALBERT Praha', -90);
    await tx('2026-05-03', 'Shell', -900);
    for (const n of [8, 7, 6, 5, 4]) await tx(monthsAgo(n, 3), 'Gym Club', -900);
    const draft = (text: string, category: string) =>
      ({ match: 'contains', text, account: null, type: 'Expense', amount_min: null, amount_max: null, category });
    await post('/api/suggestions', {
      kind: 'rule',
      payload: { draft: draft('albert', 'E2E Groceries'), reason: 'Seen <b>3 times</b> <a href="https://example.com">click</a>' },
    });
    await post('/api/suggestions', { kind: 'rule', payload: { draft: draft('shell', 'E2E Fuel') } });
    await post('/api/suggestions', { kind: 'digest', payload: { text: '<img src=x onerror=alert(1)>' } });
  });

  // Detection adds the "maybe stopped" notice; the toast says so.
  await page.getByRole('navigation').getByRole('link', { name: /Recurring/ }).click();
  await page.getByRole('button', { name: /Detect recurring/ }).click();
  await expect(page.getByText(/Detection complete: 1 recurring patterns .*\. 1 new in the Inbox/)).toBeVisible();

  const nav = page.getByRole('navigation');
  await expect(nav.getByLabel('4 to review')).toBeVisible();
  await nav.getByRole('link', { name: /^Inbox/ }).click();

  const rules = page.getByRole('region', { name: 'Rule proposals' });
  const albert = rules.getByTestId('suggestion').filter({ hasText: '"albert"' });
  // Plain text: the reason's markup shows as typed, and nothing in it becomes a link or an image.
  await expect(albert).toContainText('Seen <b>3 times</b> <a href="https://example.com">click</a>');
  await expect(page.locator('main a, main img')).toHaveCount(0);
  await expect(albert.getByTestId('suggestion-preview')).toHaveText('2 rows would change if you accept.');

  // Edit: accept a changed version.
  await albert.getByRole('button', { name: 'Edit' }).click();
  const modal = page.locator('.modal');
  await expect(modal.getByRole('heading', { name: 'Edit suggested rule' })).toBeVisible();
  await modal.getByRole('combobox', { name: 'Category' }).selectOption('E2E Eating out');
  await expect(modal.getByTestId('rule-preview')).toContainText('2 rows would change when you save.');
  await modal.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByText('Accepted with your changes: 2 rows categorised')).toBeVisible();
  await expect(nav.getByLabel('3 to review')).toBeVisible();

  // Accept as suggested.
  await rules.getByTestId('suggestion').filter({ hasText: '"shell"' }).getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('Accepted: 1 row categorised')).toBeVisible();
  await expect(rules).toHaveCount(0);

  // Accepting "maybe stopped" marks the item inactive.
  const stopped = page.getByRole('region', { name: 'Payments that may have stopped' }).getByTestId('suggestion');
  await expect(stopped).toContainText('Gym Club: no monthly payment since');
  await stopped.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();

  // An unknown kind can only be rejected; its payload is shown as text.
  const other = page.getByRole('region', { name: 'Other: digest' }).getByTestId('suggestion');
  await expect(other).toContainText('<img src=x onerror=alert(1)>');
  await expect(other.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await other.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Rejected', { exact: true })).toBeVisible();

  await expect(page.getByText('Nothing to review.')).toBeVisible();
  await expect(nav.getByLabel(/to review/)).toHaveCount(0);

  const state = await page.evaluate(async () => {
    const tx = (await (await fetch('/api/transactions?limit=50')).json()).rows;
    const recurring = await (await fetch('/api/recurring')).json();
    return {
      categories: Object.fromEntries(tx.filter((r: any) => r.description !== 'Gym Club').map((r: any) => [r.description, r.category])),
      gymActive: recurring.find((r: any) => r.description === 'Gym Club').active,
    };
  });
  expect(state).toEqual({
    categories: { Albert: 'E2E Eating out', 'ALBERT Praha': 'E2E Eating out', Shell: 'E2E Fuel' },
    gymActive: 0,
  });
});
