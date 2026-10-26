import { test, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, launch, watchErrors } from './app';

// App updates (#3353) against a local fake of the GitHub "latest release" API. FINANCE_UPDATE_TEST_URL
// puts the app in notify mode (the macOS flow), even in dev or with a test profile. Without it an E2E
// profile never checks, so packaged E2E runs never reach GitHub. electron-updater's Windows download
// can't run from a test feed: the "Restart to update" bar is driven with the status it would show.
const DOWNLOADS_URL = 'https://punterdigital.github.io/personal-apps/';
let feed: http.Server;
let feedUrl = '';
let feedHits = 0;

test.beforeAll(async () => {
  feed = http.createServer((_req, res) => {
    feedHits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tag_name: 'v99.0.0' }));
  });
  await new Promise<void>((r) => feed.listen(0, '127.0.0.1', () => r()));
  feedUrl = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/releases/latest`;
});
test.afterAll(() => new Promise<void>((r) => feed.close(() => r())));

/** Record shell.openExternal calls instead of opening a real browser. */
async function stubOpenExternal(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __opened: string[] }).__opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
}
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);

// The refused install below is an HTTP 409, which Chromium logs as a console error.
const unexpected = (errors: string[]) => errors.filter((e) => !/status of 409/.test(e));

test('update bar: Download, Later, Check now, Restart to update, and the setting', async () => {
  test.setTimeout(120_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-e2e-updates-'));
  const errors: string[] = [];
  let current = await launch(userData, { FINANCE_UPDATE_TEST_URL: feedUrl });
  try {
    await stubOpenExternal(current.app);
    const page = await current.app.firstWindow();
    watchErrors(page, errors);

    // The launch check runs a few seconds after startup.
    const bar = page.getByRole('region', { name: 'App update' });
    await expect(bar).toContainText('Finance Dashboard v99.0.0 is available.', { timeout: 20_000 });
    expect(feedHits).toBeGreaterThan(0);
    await bar.getByRole('button', { name: 'Download' }).click();
    await expect.poll(() => opened(current.app)).toEqual([DOWNLOADS_URL]);
    await bar.getByRole('button', { name: 'Later' }).click();
    await expect(bar).toBeHidden();

    // Settings: the toggle is on by default, and "Check now" brings the dismissed bar back.
    await page.getByRole('link', { name: 'Settings' }).click();
    const toggle = page.getByRole('checkbox', { name: 'Check for updates' });
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    const hitsBefore = feedHits;
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Version 99.0.0 is available.' })).toBeVisible();
    await expect(bar).toContainText('Finance Dashboard v99.0.0 is available.');
    expect(feedHits).toBeGreaterThan(hitsBefore);

    // Windows: once electron-updater has downloaded, the bar offers a restart. Nothing was really
    // downloaded, so the main process refuses, which proves the button reaches it.
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('update-status', { detail: { state: 'downloaded', mode: 'install', version: '99.0.1' } }),
      ),
    );
    await expect(bar).toContainText('Finance Dashboard v99.0.1 is ready to install.');
    await bar.getByRole('button', { name: 'Restart to update' }).click();
    await expect(bar.getByRole('alert')).toContainText('No update has been downloaded yet.');

    // Turn automatic checks off: saved next to the database, outside it.
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(() => JSON.parse(fs.readFileSync(path.join(userData, 'app-settings.json'), 'utf8')).checkForUpdates)
      .toBe(false);
    await current.close();

    // Relaunch with checks off: the feed is never asked and no bar appears.
    const hitsAtRestart = feedHits;
    current = await launch(userData, { FINANCE_UPDATE_TEST_URL: feedUrl });
    const page2 = await current.app.firstWindow();
    watchErrors(page2, errors);
    await page2.getByRole('link', { name: 'Settings' }).click();
    await expect(page2.getByRole('checkbox', { name: 'Check for updates' })).not.toBeChecked();
    await page2.waitForTimeout(8_000); // past the 5 s first-check delay
    expect(feedHits).toBe(hitsAtRestart);
    await expect(page2.getByRole('region', { name: 'App update' })).toBeHidden();
  } finally {
    await current.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  expect(unexpected(errors), 'renderer console errors').toEqual([]);
});

test('an E2E profile without a feed never checks for updates', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-e2e-updates-'));
  const errors: string[] = [];
  const before = feedHits;
  const { app, close } = await launch(userData);
  try {
    const page = await app.firstWindow();
    watchErrors(page, errors);
    await page.getByRole('link', { name: 'Settings' }).click();
    const status = await page.evaluate(() => fetch('/api/app/update').then((r) => r.json()));
    expect(status).toEqual({ state: 'idle', mode: 'off' });
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Update checks only run in the installed app.' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'App update' })).toBeHidden();
    expect(feedHits).toBe(before);
  } finally {
    await close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  expect(errors, 'renderer console errors').toEqual([]);
});
