import type { RecurringItem } from './types';

// Days after the expected date before a missing payment counts as "maybe stopped" (#3487).
export const GRACE_DAYS: Record<string, number> = {
  Weekly: 3,
  'Bi-Weekly': 5,
  Monthly: 7,
  Quarterly: 14,
  Annually: 30,
};

export type RecurringStatus = 'ok' | 'overdue' | 'stopped';

export function recurringStatus(item: Pick<RecurringItem, 'active' | 'next_expected' | 'frequency'>, today: string): RecurringStatus {
  if (item.active !== 1 || !item.next_expected || item.next_expected >= today) return 'ok';
  const grace = GRACE_DAYS[item.frequency ?? ''] ?? 7;
  const limit = new Date(item.next_expected + 'T00:00:00Z');
  limit.setUTCDate(limit.getUTCDate() + grace);
  return today > limit.toISOString().slice(0, 10) ? 'stopped' : 'overdue';
}
