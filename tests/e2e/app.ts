import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Launches the app on the given profile. Never point this at a real profile.
async function launch(userData: string) {
  const executablePath = process.env.FINANCE_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    env: { ...process.env, FINANCE_E2E_USER_DATA: userData } as Record<string, string>,
  });
  let closed = false;
  app.on('close', () => (closed = true));
  return { app, close: async () => { if (!closed) await app.close(); } };
}

// Collects renderer errors, so a test fails on any console error.
function watchErrors(page: Page, errors: string[]) {
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
}

// Each test gets a fresh, throwaway profile: the real finance database is never opened.
// `relaunch()` closes the app and starts it again on the same profile (a restart), returning the
// new window.
export const test = base.extend<{
  app: ElectronApplication;
  page: Page;
  userData: string;
  relaunch: () => Promise<Page>;
}>({
  // eslint-disable-next-line no-empty-pattern
  userData: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-e2e-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  app: async ({ userData }, use) => {
    const { app, close } = await launch(userData);
    await use(app);
    await close();
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow();
    const errors: string[] = [];
    watchErrors(page, errors);
    await use(page);
    base.expect(errors, 'renderer console errors').toEqual([]);
  },
  // The first app's own fixture skips its close once this has closed it.
  relaunch: async ({ app, userData }, use) => {
    let closeCurrent = () => app.close();
    const launched: { close: () => Promise<void> }[] = [];
    const errors: string[] = [];
    await use(async () => {
      await closeCurrent();
      const next = await launch(userData);
      launched.push(next);
      closeCurrent = next.close;
      const page = await next.app.firstWindow();
      watchErrors(page, errors);
      return page;
    });
    for (const l of launched) await l.close();
    base.expect(errors, 'renderer console errors after relaunch').toEqual([]);
  },
});

export const expect = test.expect;
