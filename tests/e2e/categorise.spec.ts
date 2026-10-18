import { expect, test } from './app';

// Made-up CZK rows in the current month, so nothing needs an FX rate.
test('assign categories one at a time: suggestion, filter, new category, skip and undo', async ({ page }) => {
  const month = new Date().toISOString().slice(0, 7);
  await page.evaluate(async (m) => {
    const post = (url: string, body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post('/api/accounts', { name: 'E2E Current', type: 'Personal', base_currency: 'CZK' });
    await post('/api/categories', { name: 'Groceries', type: 'Expense', grp: 'Food' });
    await post('/api/categories', { name: 'Eating out', type: 'Expense', grp: 'Food' });
    await post('/api/categories', { name: 'Rent', type: 'Expense', grp: 'Housing' });
    await post('/api/categories', { name: 'Salary', type: 'Income', grp: 'Work' });
    const tx = (day: string, description: string, amount: number, extra: Record<string, unknown> = {}) =>
      post('/api/transactions', { date: `${m}-${day}`, description, account: 'E2E Current', amount, currency: 'CZK', type: 'Expense', ...extra });
    await tx('01', 'Žabka', -120, { category: 'Eating out' }); // history for the suggestion
    await tx('02', 'Flat rent', -15000);
    await tx('03', 'Mystery shop', -250);
    await tx('04', 'ŽABKA', -90);
    await tx('05', 'Payroll', 60000, { type: 'Income' });
    await tx('06', 'To savings', -5000, { type: 'Transfer' }); // transfers never queue
  }, month);
  await page.reload();

  const navLink = page.getByRole('navigation').getByRole('link', { name: /Assign categories/ });
  await expect(navLink).toContainText('4');
  await navLink.click();

  const remaining = page.getByTestId('cat-remaining');
  const card = page.getByTestId('cat-card');
  const find = page.getByRole('textbox', { name: 'Find a category' });
  const options = page.getByRole('listbox', { name: 'Categories' }).getByRole('option');
  await expect(remaining).toHaveText('4 transactions without a category');

  // Newest first: income shows only income categories. Enter takes the highlighted one.
  await expect(card).toContainText('Payroll');
  await expect(card).toContainText('Income');
  await expect(options).toHaveText([/Salary/]);
  await expect(find).toBeFocused();
  await page.keyboard.press('Enter');

  // The suggestion (same description, other case, Czech letters) comes first and highlighted.
  await expect(card).toContainText('ŽABKA');
  await expect(options.first()).toHaveText(/Eating out\s*Suggested/);
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(options).toHaveCount(3);
  await page.keyboard.press('Enter');

  // Type to filter, arrow keys move the highlight.
  await expect(card).toContainText('Mystery shop');
  await expect(remaining).toHaveText('2 transactions without a category');
  await find.fill('o');
  await expect(options).toHaveText([/Eating out/, /Groceries/, /Add “o”/]);
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(find).toHaveValue('');

  // Shift+Enter skips; a new category can be added from the picker.
  await page.keyboard.press('Shift+Enter');
  await expect(card).toContainText('Flat rent');
  await find.fill('Utilities');
  await expect(options).toHaveText([/Add “Utilities” as a new expense category/]);
  await options.first().click();
  await expect(page.getByTestId('cat-done')).toContainText('1 skipped');

  // Undo brings Flat rent back; pick Rent with the mouse instead.
  await page.getByRole('button', { name: '↶ Undo' }).click();
  await expect(card).toContainText('Flat rent');
  await expect(remaining).toHaveText('2 transactions without a category · 1 skipped');
  await options.filter({ hasText: 'Rent' }).click();
  await expect(page.getByTestId('cat-done')).toBeVisible();

  // The skipped one comes back for review.
  await page.getByRole('button', { name: 'Review skipped' }).click();
  await expect(card).toContainText('Mystery shop');
  await options.filter({ hasText: 'Groceries' }).click();
  await expect(page.getByTestId('cat-done')).toContainText('Every transaction has a category');
  await expect(remaining).toHaveText('0 transactions without a category');
  await expect(navLink).toHaveText('Assign categories');

  const stored = await page.evaluate(async () => (await (await fetch('/api/transactions')).json()).rows);
  const by = (d: string) => stored.find((t: any) => t.description === d).category;
  expect([by('Payroll'), by('ŽABKA'), by('Mystery shop'), by('Flat rent'), by('To savings')]).toEqual(['Salary', 'Eating out', 'Groceries', 'Rent', null]);
  const cats = await page.evaluate(async () => (await (await fetch('/api/categories')).json()).map((c: any) => c.name));
  expect(cats).toContain('Utilities'); // added from the picker, kept after the undo
});
