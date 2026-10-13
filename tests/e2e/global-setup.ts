import { createRequire } from 'node:module';

// Electron 44+ downloads its binary lazily on first require('electron'). Resolve it once here, before
// parallel workers start, so two workers never race on the download.
export default function globalSetup() {
  if (process.env.FINANCE_E2E_EXECUTABLE) return;
  const electronPath = createRequire(import.meta.url)('electron') as unknown as string;
  if (!electronPath) throw new Error('Electron binary not found');
}
