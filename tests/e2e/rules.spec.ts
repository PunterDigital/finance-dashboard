import { expect, test } from './app';

// Made-up CZK rows, so nothing needs an FX rate.
test('rules: create a rule with a preview, apply it, edit it and roll it back', async ({ page }) => {
  await page.evaluate(async () => {
    const post = (url: string, body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post('/api/accounts', { name: 'E2E Current', type: 'Personal', base_currency: 'CZK' });
    await post('/api/categories', { name: 'E2E Groceries', type: 'Expense', grp: 'Food' });
    await post('/api/categories', { name: 'E2E Eating out', type: 'Expense', grp: 'Food' });
    const tx = (date: string, description: string, amount: number, category?: string) =>
      post('/api/transactions', { date, description, account: 'E2E Current', amount, currency: 'CZK', type: 'Expense', category });
    await tx('2026-05-01', 'ALBERT Praha', -500);
    await tx('2026-05-02', 'Albert', -90);
    await tx('2026-05-03', 'Albert', -70, 'E2E Eating out'); // the user's own choice: never changed
    await tx('2026-05-04', 'Shell', -900);
  });

  await page.getByRole('navigation').getByRole('link', { name: 'Rules', exact: true }).click();
  await expect(page.getByText('No rules yet')).toBeVisible();

  // Create: the preview shows what saving would change before anything is saved.
  await page.getByRole('button', { name: '+ Add rule' }).click();
  const modal = page.locator('.modal');
  await expect(modal.getByRole('button', { name: 'Save rule' })).toBeDisabled();
  await modal.getByRole('textbox', { name: 'Text' }).fill('albert');
  await modal.getByRole('combobox', { name: 'Category' }).selectOption('E2E Groceries');
  const preview = modal.getByTestId('rule-preview');
  await expect(preview).toContainText('2 rows would change when you save.');
  await expect(preview.getByRole('row')).toHaveCount(3); // header + 2
  await expect(preview).toContainText('ALBERT Praha');
  await expect(preview).not.toContainText('Shell');

  // Narrowing the rule updates the preview.
  await modal.getByRole('spinbutton', { name: 'Min amount' }).fill('100');
  await expect(preview).toContainText('1 row would change when you save.');
  await modal.getByRole('spinbutton', { name: 'Min amount' }).fill('');
  await expect(preview).toContainText('2 rows would change when you save.');

  await modal.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByText('Rule saved: 2 rows categorised')).toBeVisible();
  const ruleRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: /contains albert/ }) });
  await expect(ruleRow).toContainText('v1');
  await expect(ruleRow.getByRole('cell').nth(6)).toHaveText('2');

  const categories = () =>
    page.evaluate(async () => {
      const res = await (await fetch('/api/transactions?limit=50')).json();
      return Object.fromEntries(res.rows.map((r: any) => [`${r.date} ${r.description}`, r.category]));
    });
  expect(await categories()).toEqual({
    '2026-05-01 ALBERT Praha': 'E2E Groceries',
    '2026-05-02 Albert': 'E2E Groceries',
    '2026-05-03 Albert': 'E2E Eating out',
    '2026-05-04 Shell': null,
  });

  // A new uncategorised row is picked up by "Apply rules now".
  await page.evaluate(() =>
    fetch('/api/transactions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-05-05', description: 'albert  express', account: 'E2E Current', amount: -40, currency: 'CZK', type: 'Expense' }),
    }));
  await page.getByRole('button', { name: 'Apply rules now' }).click();
  await expect(page.getByText('Rules applied: 1 row categorised')).toBeVisible();

  // Edit: a new version re-categorises the rule's rows.
  await ruleRow.getByRole('button', { name: 'Edit' }).click();
  await modal.getByRole('combobox', { name: 'Category' }).selectOption('E2E Eating out');
  await expect(preview).toContainText('3 rows would change when you save.');
  await modal.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByText('Rule saved: 3 rows categorised')).toBeVisible();
  await expect(ruleRow).toContainText('v2');
  expect((await categories())['2026-05-01 ALBERT Praha']).toBe('E2E Eating out');

  // Roll back to v1: previewed first, then written as v3.
  await ruleRow.getByRole('button', { name: 'History' }).click();
  await modal.getByRole('button', { name: 'Roll back to v1' }).click();
  await expect(modal.getByTestId('rollback-preview')).toContainText('3 rows would change');
  await modal.getByTestId('rollback-preview').getByRole('button', { name: 'Roll back', exact: true }).click();
  await expect(page.getByText('Rolled back to v1: 3 rows changed')).toBeVisible();
  await expect(ruleRow).toContainText('v3');
  expect(await categories()).toEqual({
    '2026-05-01 ALBERT Praha': 'E2E Groceries',
    '2026-05-02 Albert': 'E2E Groceries',
    '2026-05-03 Albert': 'E2E Eating out',
    '2026-05-04 Shell': null,
    '2026-05-05 albert  express': 'E2E Groceries',
  });

  // The history lists every version and the audit log.
  await ruleRow.getByRole('button', { name: 'History' }).click();
  await expect(modal.getByRole('row')).toHaveCount(4); // header + v3, v2, v1
  await expect(modal.getByRole('listitem')).toHaveText([/rollback \(v3\) by user/, /edit \(v2\) by user/, /create \(v1\) by user/]);
  await modal.getByRole('button', { name: 'Close' }).click();

  // Retire: the rule stops, the rows keep their category.
  await ruleRow.getByRole('button', { name: 'Retire' }).click();
  await expect(ruleRow).toContainText('retired');
  await expect(page.getByRole('button', { name: 'Apply rules now' })).toBeDisabled();
});
