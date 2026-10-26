// App updates (#3353): Electron wiring for ./updater-core.ts.
// Windows: electron-updater downloads from GitHub Releases (latest.yml) and waits for "Restart to
// update". macOS: a GitHub API version check, and the UI links to the downloads page. Dev and E2E
// profiles never check (see resolveUpdateMode). The UI reads the status over the API
// (/api/app/update, server/updates.ts): the renderer has no preload.

import { app } from 'electron';
import { createRequire } from 'node:module';
import type { AppUpdater } from 'electron-updater';
import {
  Updater,
  fetchLatestReleaseVersion,
  resolveUpdateMode,
  scheduleUpdateChecks,
  type InstallUpdater,
} from './updater-core.js';

const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/PunterDigital/finance-dashboard/releases/latest';
const FIRST_CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const log = (message: string) => console.log(message);

export function createUpdater(): Updater {
  const testFeedUrl = process.env.FINANCE_UPDATE_TEST_URL || undefined;
  return new Updater({
    mode: resolveUpdateMode({
      platform: process.platform,
      isPackaged: app.isPackaged,
      isolatedProfile: !!process.env.FINANCE_E2E_USER_DATA,
      allowInTestProfile: process.env.FINANCE_UPDATE_IN_TEST_PROFILE === '1',
      disabledByEnv: process.env.FINANCE_DISABLE_UPDATES === '1',
      testFeedUrl,
    }),
    currentVersion: app.getVersion(),
    loadInstaller: async () => {
      // require, not import(): main.js is an esbuild ESM bundle, and esbuild's interop on this external
      // CJS package loses the autoUpdater getter (undefined in the packaged app; see Nexus SSH). Lazy, so
      // dev and E2E never load it.
      const require = createRequire(import.meta.url);
      const { autoUpdater } = require('electron-updater') as { autoUpdater: AppUpdater };
      // Releases ship the full NSIS installer, never a web installer.
      autoUpdater.disableWebInstaller = true;
      autoUpdater.logger = {
        info: (m?: unknown) => log(`[updater] ${String(m)}`),
        warn: (m?: unknown) => log(`[updater] ${String(m)}`),
        error: (m?: unknown) => log(`[updater] ${String(m)}`),
        debug: () => {},
      };
      return autoUpdater as unknown as InstallUpdater;
    },
    fetchLatestVersion: () =>
      fetchLatestReleaseVersion(testFeedUrl ?? LATEST_RELEASE_API_URL, `FinanceDashboard/${app.getVersion()}`),
    log,
  });
}

/** Background checks (no-op when the mode is off). `isEnabled` reads the Settings toggle each time. */
export function startUpdateChecks(updater: Updater, isEnabled: () => boolean): void {
  log(`[updater] mode: ${updater.mode}`);
  scheduleUpdateChecks({ updater, isEnabled, firstDelayMs: FIRST_CHECK_DELAY_MS, intervalMs: CHECK_INTERVAL_MS });
}
