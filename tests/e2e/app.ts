import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test gets a fresh, throwaway profile: the real finance database is never opened.
export const test = base.extend<{ app: ElectronApplication; page: Page; userData: string }>({
  // eslint-disable-next-line no-empty-pattern
  userData: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-e2e-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  app: async ({ userData }, use) => {
    const executablePath = process.env.FINANCE_E2E_EXECUTABLE;
    const app = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
      env: { ...process.env, FINANCE_E2E_USER_DATA: userData } as Record<string, string>,
    });
    await use(app);
    await app.close();
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await use(page);
    base.expect(errors, 'renderer console errors').toEqual([]);
  },
});

export const expect = test.expect;
