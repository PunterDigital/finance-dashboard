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
    ['Settings', 'Settings'],
  ] as const) {
    const navLink = page.getByRole('link', { name: link, exact: true });
    await navLink.click();
    await expect(page.getByRole('heading', { level: 2, name: heading }).first()).toBeVisible();
    // The router marks only the current page in the sidebar.
    await expect(navLink).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('nav a[aria-current="page"]')).toHaveCount(1);
  }

  // Hash routing survives a reload.
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Settings' })).toBeVisible();
});

test('add an account, a category and a transaction, then see it reported', async ({ page }) => {
  await page.getByRole('link', { name: 'Settings' }).click();

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

  // The charts draw bars, not just axes (Recharts drops children it can't identify as React elements).
  await expect(page.locator('.recharts-bar-rectangle path').first()).toBeVisible();
  await page.getByRole('link', { name: 'Monthly Report' }).click();
  await expect(page.locator('.recharts-bar-rectangle path').first()).toBeVisible();
  await expect(page.locator('.recharts-line-dot')).toHaveCount(1); // one month: a dot, no curve yet
});
