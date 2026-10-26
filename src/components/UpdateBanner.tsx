import { useEffect, useState } from 'react';
import { api } from '../api';
import { UPDATE_STATUS_EVENT, openDownloadsPage, type UpdateStatus } from '../updates';

// "New version" bar at the top of the page (#3353; electron/updater.ts).
// Windows: shown once the update has downloaded → "Restart to update".
// macOS: shown when a newer release exists → "Download" opens the downloads page.
// The status lives in the main process; this polls it (fast while a check or download runs).
function pollDelay(status: UpdateStatus | null): number | null {
  if (!status) return 10_000;
  if (status.mode === 'off') return null; // never changes while the app runs
  if (status.state === 'idle' || status.state === 'checking') return 3_000;
  if (status.state === 'available' && status.mode === 'install') return 3_000; // downloading
  return 60_000;
}

export default function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const poll = async () => {
      let next: UpdateStatus | null = null;
      try {
        next = await api.get<UpdateStatus>('/api/app/update');
        if (!stopped) setStatus(next);
      } catch {
        // The API is in-process; a failure here means the app is closing.
      }
      const delay = pollDelay(next);
      if (!stopped && delay != null) timer = setTimeout(poll, delay);
    };
    void poll();
    // A manual check from Settings: show its result now, even for a version dismissed earlier.
    const onStatus = (e: Event) => {
      setStatus((e as CustomEvent<UpdateStatus>).detail);
      setDismissed(null);
    };
    window.addEventListener(UPDATE_STATUS_EVENT, onStatus);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener(UPDATE_STATUS_EVENT, onStatus);
    };
  }, []);

  if (!status) return null;
  const ready = status.state === 'downloaded';
  const notify = status.state === 'available' && status.mode === 'notify';
  if (!ready && !notify) return null;
  const version = status.version;
  if (version === dismissed) return null;

  const act = async () => {
    setError(null);
    if (!ready) {
      openDownloadsPage();
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/app/update/install');
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="callout update-banner" role="region" aria-label="App update">
      <span>
        {ready
          ? `Finance Dashboard v${version} is ready to install.`
          : `Finance Dashboard v${version} is available.`}
        {error && <span className="update-error" role="alert"> {error}</span>}
      </span>
      <span className="row">
        <button className="small" onClick={() => setDismissed(version)}>Later</button>
        <button className="small primary" disabled={busy} onClick={act}>
          {ready ? (busy ? 'Restarting…' : 'Restart to update') : 'Download'}
        </button>
      </span>
    </div>
  );
}
