// App update logic (#3353), ported from Nexus SSH's src/main/updater/core.ts. No Electron imports, so
// it is unit-tested (tests/unit/updater.test.ts). The Electron wiring lives in ./updater.ts.

import type { UpdateController, UpdateMode, UpdateStatus } from '../server/updates.js';

/** Compare two semver strings ("v" prefix allowed). <0 if a is older, 0 if equal, >0 if newer. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ''] = v.trim().replace(/^v/i, '').split('-', 2);
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  // 1.0.0-beta < 1.0.0
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export interface UpdateModeInput {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** FINANCE_E2E_USER_DATA is set: an E2E / throwaway profile. */
  isolatedProfile: boolean;
  /** FINANCE_UPDATE_IN_TEST_PROFILE=1: check anyway (manual test of a packaged build's real updater). */
  allowInTestProfile?: boolean;
  /** FINANCE_DISABLE_UPDATES=1. */
  disabledByEnv: boolean;
  /** FINANCE_UPDATE_TEST_URL: E2E points `notify` mode at a local fake of the GitHub API. */
  testFeedUrl?: string;
}

/**
 * What this build can do about updates. Only installed (packaged) builds check, and never with a
 * test profile, so E2E runs of the packaged app don't reach GitHub. Windows installs updates; macOS
 * can't (Squirrel.Mac refuses unsigned apps), so it only notifies.
 */
export function resolveUpdateMode(input: UpdateModeInput): UpdateMode {
  if (input.disabledByEnv) return 'off';
  if (input.testFeedUrl) return 'notify';
  if (!input.isPackaged) return 'off';
  if (input.isolatedProfile && !input.allowInTestProfile) return 'off';
  return input.platform === 'win32' ? 'install' : 'notify';
}

/** The parts of electron-updater's AppUpdater this module uses. */
export interface InstallUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  // Each call site types the payload it expects. (`never[]`, as in Nexus, no longer matches
  // EventEmitter's generic `on` in @types/node 26.)
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterDeps {
  mode: UpdateMode;
  currentVersion: string;
  /** `install` mode: electron-updater's autoUpdater (loaded lazily, on the first check). */
  loadInstaller: () => Promise<InstallUpdater>;
  /** `notify` mode: the latest published version. */
  fetchLatestVersion: () => Promise<string>;
  log: (message: string) => void;
}

export class Updater implements UpdateController {
  private status: UpdateStatus;
  private installer: InstallUpdater | null = null;
  private inFlight: Promise<UpdateStatus> | null = null;

  constructor(private readonly deps: UpdaterDeps) {
    this.status = { state: 'idle', mode: deps.mode };
  }

  get mode(): UpdateMode {
    return this.deps.mode;
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /**
   * Check for a newer version. Never throws: failures (no network, GitHub down) become an `error`
   * status and a log line. Concurrent calls share one check.
   */
  check(): Promise<UpdateStatus> {
    if (this.deps.mode === 'off') return Promise.resolve(this.status);
    // Already downloaded: nothing more to fetch until the user restarts.
    if (this.status.state === 'downloaded') return Promise.resolve(this.status);
    if (!this.inFlight) {
      this.inFlight = this.runCheck().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Restart into the downloaded update (`install` mode only). */
  install(): void {
    if (this.status.state !== 'downloaded' || !this.installer) {
      throw new Error('No update has been downloaded yet.');
    }
    this.deps.log(`[updater] restarting to install v${this.status.version}`);
    // Silent installer run (into the same folder), then relaunch the app.
    this.installer.quitAndInstall(true, true);
  }

  private async runCheck(): Promise<UpdateStatus> {
    const { mode } = this.deps;
    this.status = { state: 'checking', mode };
    try {
      if (mode === 'install') {
        const installer = await this.getInstaller();
        const result = (await installer.checkForUpdates()) as { downloadPromise?: Promise<unknown> } | null;
        // A failed download rejects this promise *and* emits `error` (handled below). Without a catch
        // here the rejection would go unhandled in the main process.
        result?.downloadPromise?.catch(() => {});
        // The events below set the status. If none fired (shouldn't happen), stay honest.
        if (this.status.state === 'checking') this.status = { state: 'up-to-date', mode };
      } else {
        const latest = await this.deps.fetchLatestVersion();
        this.status =
          compareVersions(latest, this.deps.currentVersion) > 0
            ? { state: 'available', mode, version: latest.replace(/^v/i, '') }
            : { state: 'up-to-date', mode };
      }
    } catch (err) {
      this.fail(err);
    }
    return this.status;
  }

  private fail(err: unknown): void {
    const full = err instanceof Error ? err.message : String(err);
    this.deps.log(`[updater] update check failed: ${full}`);
    // electron-updater's HTTP errors append the response headers on the following lines; the UI
    // only needs the first one ("Cannot find latest.yml in the latest release artifacts (…): HttpError: 404").
    const message = full.split('\n')[0].trim();
    // A failed background re-check must not hide an update that's already downloaded.
    if (this.status.state !== 'downloaded') this.status = { state: 'error', mode: this.deps.mode, message };
  }

  private async getInstaller(): Promise<InstallUpdater> {
    if (this.installer) return this.installer;
    const installer = await this.deps.loadInstaller();
    const { mode } = this.deps;
    installer.autoDownload = true;
    // Nothing installs without a click on "Restart to update".
    installer.autoInstallOnAppQuit = false;
    installer.on('update-available', (info: { version: string }) => {
      this.status = { state: 'available', mode, version: info.version };
    });
    installer.on('update-not-available', () => {
      this.status = { state: 'up-to-date', mode };
    });
    installer.on('update-downloaded', (info: { version: string }) => {
      this.status = { state: 'downloaded', mode, version: info.version };
    });
    // Also stops an `error` event from throwing (an EventEmitter with no `error` listener throws,
    // which in the main process would pop a native error dialog).
    installer.on('error', (err: unknown) => this.fail(err));
    this.installer = installer;
    return installer;
  }
}

/**
 * Background checks: one shortly after launch, then on an interval. Reads the setting before each
 * check, so turning it off in Settings takes effect without a restart.
 */
export function scheduleUpdateChecks(opts: {
  updater: Pick<Updater, 'check' | 'mode'>;
  isEnabled: () => boolean | Promise<boolean>;
  firstDelayMs: number;
  intervalMs: number;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    setInterval: (fn: () => void, ms: number) => unknown;
  };
}): void {
  if (opts.updater.mode === 'off') return;
  const timers = opts.timers ?? { setTimeout, setInterval };
  const tick = async () => {
    try {
      if (await opts.isEnabled()) await opts.updater.check();
    } catch {
      // check() never throws; isEnabled() failing just skips this round.
    }
  };
  timers.setTimeout(() => {
    void tick();
    timers.setInterval(() => void tick(), opts.intervalMs);
  }, opts.firstDelayMs);
}

/** `notify` mode: read the latest release's version from the GitHub API (or a test feed). */
export async function fetchLatestReleaseVersion(
  url: string,
  userAgent: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Release lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as { tag_name?: unknown };
  if (typeof body.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+/.test(body.tag_name)) {
    throw new Error('Release lookup returned no version');
  }
  return body.tag_name.replace(/^v/i, '');
}
