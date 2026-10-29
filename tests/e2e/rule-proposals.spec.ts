import { expect, test } from './app';

// Auto rule proposals (#3490). Made-up CZK rows in the current month, so nothing needs an FX rate.
test('three hand-set categories propose a rule in the Inbox; accepting it categorises the rest', async ({ page }) => {
  const month = new Date().toISOString().slice(0, 7);
  await page.evaluate(async (m) => {
    const post = (url: string, body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post('/api/accounts', { name: 'E2E Current', type: 'Personal', base_currency: 'CZK' });
    await post('/api/categories', { name: 'Groceries', type: 'Expense', grp: 'Food' });
    const tx = (day: string, description: string) =>
      post('/api/transactions', { date: `${m}-${day}`, description, account: 'E2E Current', amount: -300, currency: 'CZK', type: 'Expense' });
    await tx('01', 'Lidl Praha');
    await tx('02', 'LIDL Praha');
    await tx('03', 'Lidl  Praha');
  }, month);
  await page.reload();

  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: /Assign categories/ }).click();
  const card = page.getByTestId('cat-card');
  const find = page.getByRole('textbox', { name: 'Find a category' });
  for (let i = 0; i < 3; i++) {
    await expect(card).toContainText(/lidl/i);
    await find.fill('Groc');
    await page.keyboard.press('Enter');
  }
  // The badge updates without leaving the page.
  await expect(nav.getByLabel('1 to review')).toBeVisible();

  // A fourth row comes in later (as an import would bring it), with no category.
  await page.evaluate(async (m) => {
    await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: [{ date: `${m}-04`, description: 'lidl praha', account: 'E2E Current', amount: -120, currency: 'CZK', type: 'Expense' }] }),
    });
  }, month);

  await nav.getByRole('link', { name: /^Inbox/ }).click();
  const proposal = page.getByRole('region', { name: 'Rule proposals' }).getByTestId('suggestion');
  await expect(proposal).toContainText('Set Groceries on expense rows whose description is "lidl praha".');
  await expect(proposal).toContainText('by hand 3 times');
  await expect(proposal.getByTestId('suggestion-preview')).toHaveText('1 row would change if you accept.');
  await proposal.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('Accepted: 1 row categorised')).toBeVisible();
  await expect(nav.getByLabel(/to review/)).toHaveCount(0);

  // The rule is on the Rules page (its author, "auto", is checked in the unit tests).
  await nav.getByRole('link', { name: /^Rules/ }).click();
  await expect(page.getByRole('main')).toContainText('lidl praha');
});
