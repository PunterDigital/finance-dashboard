import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './app';

const accountNames = (file: string) => {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return (d.prepare('SELECT name FROM accounts').all() as { name: string }[]).map((r) => r.name);
  } finally {
    d.close();
  }
};

test('Settings backs up the database, then resets it after a typed confirmation', async ({ app, page, userData }) => {
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: '+ Add account' }).click();
  await page.getByLabel('Name').fill('E2E Savings');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'E2E Savings' })).toBeVisible();

  // The app asks where to save; here the download goes straight into the test profile.
  const backupFile = path.join(userData, 'e2e-backup.db');
  await app.evaluate(({ session }, file) => {
    session.defaultSession.once('will-download', (_event, item) => item.setSavePath(file));
  }, backupFile);
  await page.getByRole('link', { name: 'Back up database' }).click();
  await expect.poll(() => fs.existsSync(backupFile) && fs.statSync(backupFile).size > 0).toBe(true);
  await expect.poll(() => { try { return accountNames(backupFile); } catch { return null; } }).toEqual(['E2E Savings']);

  await page.getByRole('button', { name: 'Reset database…' }).click();
  const confirmBtn = page.getByRole('button', { name: 'Reset database', exact: true });
  await expect(confirmBtn).toBeDisabled();
  await page.getByLabel('Type RESET to confirm').fill('reset');
  await expect(confirmBtn).toBeDisabled();
  // Cancel leaves everything alone.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('cell', { name: 'E2E Savings' })).toBeVisible();

  await page.getByRole('button', { name: 'Reset database…' }).click();
  await page.getByLabel('Type RESET to confirm').fill('RESET');
  await confirmBtn.click();

  const status = page.getByRole('status').filter({ hasText: 'Database reset' });
  await expect(status).toBeVisible();
  await expect(page.getByRole('cell', { name: 'E2E Savings' })).toHaveCount(0);
  const kept = (await status.locator('.mono').textContent())!.trim();
  expect(path.dirname(kept)).toBe(userData);
  expect(accountNames(kept)).toEqual(['E2E Savings']);

  // The app carries on with the empty database.
  await page.getByRole('link', { name: 'Transactions', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Transactions' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: '+ Add account' }).click();
  await page.getByLabel('Name').fill('E2E After reset');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'E2E After reset' })).toBeVisible();
});
