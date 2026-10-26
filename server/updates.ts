// App updates as the API sees them (#3353). The desktop shell (electron/updater.ts) registers the real
// updater here; without one (dev server, unit tests) updates are simply off. No Electron imports.

/** install: Windows downloads and installs. notify: macOS only says so. off: dev, tests, disabled. */
export type UpdateMode = 'install' | 'notify' | 'off';

export type UpdateStatus =
  | { state: 'idle'; mode: UpdateMode }
  | { state: 'checking'; mode: UpdateMode }
  | { state: 'up-to-date'; mode: UpdateMode }
  /** A newer version exists. In `install` mode it is downloading. */
  | { state: 'available'; mode: UpdateMode; version: string }
  /** `install` mode only: downloaded and waiting for "Restart to update". */
  | { state: 'downloaded'; mode: UpdateMode; version: string }
  | { state: 'error'; mode: UpdateMode; message: string };

export interface UpdateController {
  getStatus(): UpdateStatus;
  /** Never rejects: failures come back as an `error` status. */
  check(): Promise<UpdateStatus>;
  /** Throws when nothing has been downloaded. */
  install(): void;
}

export const NOT_INSTALLED_MESSAGE = 'Update checks only run in the installed app.';

const off: UpdateController = {
  getStatus: () => ({ state: 'idle', mode: 'off' }),
  check: async () => ({ state: 'idle', mode: 'off' }),
  install: () => {
    throw new Error(NOT_INSTALLED_MESSAGE);
  },
};

let controller: UpdateController = off;

export function setUpdateController(next: UpdateController | null) {
  controller = next ?? off;
}

export function getUpdateController(): UpdateController {
  return controller;
}
