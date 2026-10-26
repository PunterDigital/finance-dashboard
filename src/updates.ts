import type { UpdateStatus } from '../server/updates';

export type { UpdateStatus };

// macOS can't install an unsigned app's update itself, so "Download" opens the downloads page.
export const DOWNLOADS_URL = 'https://punterdigital.github.io/personal-apps/';

// Settings → "Check now" announces its result, so the banner shows it without waiting for a poll.
export const UPDATE_STATUS_EVENT = 'update-status';

export function announceUpdateStatus(status: UpdateStatus) {
  window.dispatchEvent(new CustomEvent<UpdateStatus>(UPDATE_STATUS_EVENT, { detail: status }));
}

export function openDownloadsPage() {
  // The desktop shell opens http(s) links from window.open in the system browser.
  window.open(DOWNLOADS_URL, '_blank', 'noopener,noreferrer');
}
