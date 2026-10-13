import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './app';

test('launches with an empty isolated database and every page renders', async ({ app, page, userData }) => {
  await expect(page.getByRole('heading', { name: 'Finance' })).toBeVisible();
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userData);
  expect(fs.existsSync(path.join(userData, 'finance.db'))).toBe(true);

  // The API must only listen on loopback.
  expect(new URL(page.url()).hostname).toBe('127.0.0.1');

  for (const [link, heading] of [
    ['Transactions', 'Transactions'],
    ['Transfers', /Transfers/],
    ['Import CSV', /Import/],
    ['Monthly Report', /Monthly/],
    ['Spend per Category', /Spend per Category/],
    ['Burn Rate', /Burn Rate/],
    ['Recurring', /Recurring/],
    ['Accounts & Categories', 'Accounts & Categories'],
  ] as const) {
    await page.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: heading }).first()).toBeVisible();
  }
});

test('add an account, a category and a transaction, then see it reported', async ({ page }) => {
  await page.getByRole('link', { name: 'Accounts & Categories' }).click();

  await page.getByRole('button', { name: '+ Add account' }).click();
  await page.getByLabel('Name').fill('E2E Current');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'E2E Current' })).toBeVisible();

  await page.getByRole('button', { name: '+ Add category' }).click();
  await page.getByLabel('Name').fill('E2E Groceries');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'E2E Groceries' })).toBeVisible();

  await page.getByRole('link', { name: 'Transactions', exact: true }).click();
  await page.getByRole('button', { name: '+ Add transaction' }).click();
  const today = new Date().toISOString().slice(0, 10);
  await page.getByLabel('Date').fill(today);
  await page.getByLabel('Description').fill('E2E weekly shop');
  await page.getByRole('combobox', { name: 'Account', exact: true }).last().selectOption('E2E Current');
  await page.getByRole('combobox', { name: 'Category', exact: true }).last().selectOption('E2E Groceries');
  await page.getByLabel('Amount').fill('-1234');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'E2E weekly shop' })).toBeVisible();

  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByText('E2E Groceries').first()).toBeVisible();
});
