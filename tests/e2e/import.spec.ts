import { expect, test } from './app';

// Made-up rows in Wise's export format. CZK, so the import needs no FX lookups.
const WISE_CSV = `"TransferWise ID",Date,"Date Time",Amount,Currency,Description,"Payment Reference","Running Balance","Exchange From","Exchange To","Exchange Rate","Payer Name","Payee Name","Payee Account Number",Merchant,"Card Last Four Digits","Card Holder Full Name",Attachment,Note,"Total fees","Exchange To Amount","Transaction Type","Transaction Details Type"
CARD-1,14-10-2026,"14-10-2026 12:01:02.123",-250.00,CZK,"E2E coffee beans",,750.00,,,,,,,"E2E Roastery",1234,"Test Person",,,0.00,,DEBIT,CARD
TRANSFER-2,13-10-2026,"13-10-2026 09:00:00.000",1000.00,CZK,"E2E refund",,1000.00,,,,"Test Person",,,,,,,"E2E note",0.00,,CREDIT,DEPOSIT
`;

test('a Wise CSV is mapped automatically and imports without touching the dropdowns', async ({ page }) => {
  await page.getByRole('link', { name: 'Accounts & Categories' }).click();
  await page.getByRole('button', { name: '+ Add account' }).click();
  await page.getByLabel('Name').fill('E2E Wise');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'E2E Wise' })).toBeVisible();

  await page.getByRole('link', { name: 'Import CSV' }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'wise.csv', mimeType: 'text/csv', buffer: Buffer.from(WISE_CSV) });
  await expect(page.getByText('Auto-mapped 6 columns')).toBeVisible();

  const roleOf = (column: string) => page.locator('.map-col', { has: page.locator('.col-name', { hasText: new RegExp(`^${column}$`) }) }).locator('select');
  await expect(roleOf('Date')).toHaveValue('date');
  await expect(roleOf('Date Time')).toHaveValue('');
  await expect(roleOf('Amount')).toHaveValue('amount');
  await expect(roleOf('Running Balance')).toHaveValue('');
  await expect(roleOf('Exchange To Amount')).toHaveValue('');
  await expect(roleOf('Currency')).toHaveValue('currency');
  await expect(roleOf('Description')).toHaveValue('description');
  await expect(roleOf('Note')).toHaveValue('notes');
  await expect(roleOf('Transaction Type')).toHaveValue('type');
  await expect(roleOf('Transaction Details Type')).toHaveValue('');

  // A guess can still be changed by hand.
  await roleOf('Note').selectOption('');
  await roleOf('Note').selectOption('notes');

  await page.getByRole('combobox', { name: /Default account/ }).selectOption('E2E Wise');
  await page.getByRole('button', { name: 'Preview →' }).click();
  await expect(page.getByText('2 of 2 rows will be imported')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'E2E coffee beans' })).toBeVisible();

  await page.getByRole('button', { name: 'Import 2 transactions' }).click();
  await expect(page.getByText('2 transactions imported from wise.csv')).toBeVisible();

  await page.getByRole('link', { name: 'View transactions' }).click();
  const coffee = page.getByRole('row', { name: /E2E coffee beans/ });
  await expect(coffee).toContainText('14 Oct 2026');
  await expect(coffee).toContainText('Expense');
  const refund = page.getByRole('row', { name: /E2E refund/ });
  await expect(refund).toContainText('13 Oct 2026');
  await expect(refund).toContainText('Income');

  const saved = await page.evaluate(async () => (await (await fetch('/api/transactions')).json()).rows);
  expect(saved.map((t: any) => [t.date, t.description, t.amount, t.currency, t.type, t.notes, t.account])).toEqual([
    ['2026-10-14', 'E2E coffee beans', 250, 'CZK', 'Expense', null, 'E2E Wise'],
    ['2026-10-13', 'E2E refund', 1000, 'CZK', 'Income', 'E2E note', 'E2E Wise'],
  ]);
});
