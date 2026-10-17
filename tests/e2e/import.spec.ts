import { expect, test } from './app';

// Made-up rows in Wise's export format. CZK, so the import needs no FX lookups.
const WISE_CSV = `"TransferWise ID",Date,"Date Time",Amount,Currency,Description,"Payment Reference","Running Balance","Exchange From","Exchange To","Exchange Rate","Payer Name","Payee Name","Payee Account Number",Merchant,"Card Last Four Digits","Card Holder Full Name",Attachment,Note,"Total fees","Exchange To Amount","Transaction Type","Transaction Details Type"
CARD-1,14-10-2026,"14-10-2026 12:01:02.123",-250.00,CZK,"E2E coffee beans",,750.00,,,,,,,"E2E Roastery",1234,"Test Person",,,0.00,,DEBIT,CARD
TRANSFER-2,13-10-2026,"13-10-2026 09:00:00.000",1000.00,CZK,"E2E refund",,1000.00,,,,"Test Person",,,,,,,"E2E note",0.00,,CREDIT,DEPOSIT
`;

test('a Wise CSV is mapped automatically and imports without touching the dropdowns', async ({ page }) => {
  await page.getByRole('link', { name: 'Settings' }).click();
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

// Made-up statement whose headers match nothing, so every column is mapped by hand. CZK: no FX lookups.
const BANK_CSV = `Booked,What,Spent,Received
2026-10-05,E2E groceries,450.50,
2026-10-06,E2E salary,,30000
2026-10-07,E2E rent,12000,
2026-10-07,E2E rent,12000,
`;
const NEXT_BANK_CSV = `Booked,What,Spent,Received
2026-10-05,E2E groceries,450.50,
2026-10-08,E2E pharmacy,89,
`;

test('a bank CSV mapped by hand saves a template, flags duplicates and imports', async ({ page }) => {
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: '+ Add account' }).click();
  await page.getByLabel('Name').fill('E2E Bank');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'E2E Bank' })).toBeVisible();

  const roleOf = (column: string) => page.locator('.map-col', { has: page.locator('.col-name', { hasText: new RegExp(`^${column}$`) }) }).locator('select');
  const upload = (name: string, csv: string) =>
    page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv) });

  await page.getByRole('link', { name: 'Import CSV' }).click();
  await upload('bank-october.csv', BANK_CSV);
  await expect(page.getByRole('heading', { name: /bank-october\.csv/ })).toContainText('4 rows');
  for (const column of ['Booked', 'What', 'Spent', 'Received']) await expect(roleOf(column)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Preview →' })).toBeDisabled();

  await roleOf('Booked').selectOption('date');
  await roleOf('What').selectOption('description');
  await roleOf('Spent').selectOption('debit');
  await roleOf('Received').selectOption('credit');
  await page.getByRole('combobox', { name: /Default account/ }).selectOption('E2E Bank');
  await page.getByPlaceholder('Template name…').fill('E2E Bank export');
  await page.getByRole('button', { name: 'Save as template' }).click();
  await expect(page.getByText('Template "E2E Bank export" saved')).toBeVisible();

  // The file repeats the rent row: it is flagged and skipped by default.
  await page.getByRole('button', { name: 'Preview →' }).click();
  await expect(page.getByText('3 of 4 rows will be imported')).toBeVisible();
  await expect(page.getByText('1 duplicates')).toBeVisible();
  const rent = page.getByRole('row', { name: /E2E rent/ });
  await expect(rent).toHaveCount(2);
  await expect(rent.nth(0)).toContainText('ok');
  await expect(rent.nth(1)).toContainText('repeat in file');
  await expect(page.getByRole('row', { name: /E2E salary/ })).toContainText('Income');
  await expect(page.getByRole('row', { name: /E2E groceries/ })).toContainText('Expense');

  await page.getByRole('button', { name: 'Import 3 transactions' }).click();
  await expect(page.getByText('3 transactions imported from bank-october.csv')).toBeVisible();
  await expect(page.getByText('1 duplicates skipped')).toBeVisible();

  // Next month's file: the saved template maps it in one click, and the overlap with the database is flagged.
  await page.getByRole('button', { name: 'Import another file' }).click();
  await upload('bank-november.csv', NEXT_BANK_CSV);
  await page.getByRole('button', { name: 'E2E Bank export', exact: true }).click();
  await expect(page.getByText('Template "E2E Bank export" applied (4 of 4 columns matched)')).toBeVisible();
  await expect(roleOf('Booked')).toHaveValue('date');
  await expect(roleOf('What')).toHaveValue('description');
  await expect(roleOf('Spent')).toHaveValue('debit');
  await expect(roleOf('Received')).toHaveValue('credit');
  await expect(page.getByRole('combobox', { name: /Default account/ })).toHaveValue('E2E Bank');

  await page.getByRole('button', { name: 'Preview →' }).click();
  await expect(page.getByText('1 of 2 rows will be imported')).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E groceries/ })).toContainText('duplicate');
  await expect(page.getByRole('row', { name: /E2E pharmacy/ })).toContainText('ok');
  await page.getByRole('button', { name: 'Import 1 transactions' }).click();
  await expect(page.getByText('1 transactions imported from bank-november.csv')).toBeVisible();

  await page.getByRole('link', { name: 'View transactions' }).click();
  await expect(page.getByRole('row', { name: /E2E pharmacy/ })).toContainText('8 Oct 2026');
  await expect(page.getByRole('row', { name: /E2E rent/ })).toHaveCount(1);
  await expect(page.getByRole('row', { name: /E2E groceries/ })).toHaveCount(1);
  await expect(page.getByRole('row', { name: /E2E salary/ })).toContainText('Income');

  const saved = await page.evaluate(async () => (await (await fetch('/api/transactions')).json()).rows);
  expect(saved.map((t: any) => [t.date, t.description, t.amount, t.currency, t.type, t.account, t.amount_czk])).toEqual([
    ['2026-10-08', 'E2E pharmacy', 89, 'CZK', 'Expense', 'E2E Bank', 89],
    ['2026-10-07', 'E2E rent', 12000, 'CZK', 'Expense', 'E2E Bank', 12000],
    ['2026-10-06', 'E2E salary', 30000, 'CZK', 'Income', 'E2E Bank', 30000],
    ['2026-10-05', 'E2E groceries', 450.5, 'CZK', 'Expense', 'E2E Bank', 450.5],
  ]);
});
