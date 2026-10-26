import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './db.js';

// App preferences that aren't finance data (#3353), in app-settings.json next to the database, so
// importing or resetting the database leaves them alone. Missing file or key = the default.
export interface AppSettings {
  /** Automatic update checks (launch + every 6 h). Default on. */
  checkForUpdates: boolean;
}

export const appSettingsPath = () => path.join(dataDir, 'app-settings.json');

function readRaw(): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(appSettingsPath(), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function readAppSettings(): AppSettings {
  const raw = readRaw();
  return { checkForUpdates: raw.checkForUpdates !== false };
}

/** Merges `patch` into the file, keeping any keys this version doesn't know about. */
export function writeAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...readRaw(), ...patch };
  const file = appSettingsPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return readAppSettings();
}
