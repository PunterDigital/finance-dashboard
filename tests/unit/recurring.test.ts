import { beforeEach, describe, expect, it } from 'vitest';
import { startApi } from './helpers';
import { recurringStatus } from '../../src/recurring-status';

const api = startApi();

const monthly = (start: string, count: number) =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(start + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + i);
    return d.toISOString().slice(0, 10);
  });

const expense = (description: string, amount: number, date: string) =>
  api.post('/api/transactions', { date, description, account: 'Main', amount, currency: 'CZK', type: 'Expense', category: 'Software/SaaS' });

type Row = { description: string; amount: number; previous_amount: number | null; price_changed_on: string | null; occurrences: number; frequency: string; active: number };
const recurring = async () => (await api.get('/api/recurring')).body as Row[];

beforeEach(async () => {
  const rows = (await api.get('/api/transactions?limit=10000')).body.rows as { id: number }[];
  for (const r of rows) await api.del(`/api/transactions/${r.id}`);
  for (const r of await recurring()) await api.del(`/api/recurring/${(r as unknown as { id: number }).id}`);
});

describe('recurring detection', () => {
  it('finds a steady monthly payment', async () => {
    for (const d of monthly('2026-01-05', 4)) await expense('Netflix', -299, d);
    await api.post('/api/recurring/detect');
    const rows = await recurring();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: 'Netflix', amount: -299, frequency: 'Monthly', occurrences: 4, previous_amount: null, price_changed_on: null });
  });

  it('keeps one item through a price change and records the old price', async () => {
    const dates = monthly('2026-01-05', 6);
    for (const d of dates.slice(0, 4)) await expense('Spotify', -199, d);
    for (const d of dates.slice(4)) await expense('Spotify', -249, d);
    const result = (await api.post('/api/recurring/detect')).body;
    expect(result.found).toBe(1);
    const rows = await recurring();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: -249, previous_amount: -199, price_changed_on: dates[4], occurrences: 6, frequency: 'Monthly' });
  });

  it('catches a price change after only one payment at the new price', async () => {
    const dates = monthly('2026-01-05', 4);
    for (const d of dates.slice(0, 3)) await expense('Hosting', -500, d);
    await expense('Hosting', -650, dates[3]);
    await api.post('/api/recurring/detect');
    const rows = await recurring();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: -650, previous_amount: -500, price_changed_on: dates[3], occurrences: 4 });
  });

  it('keeps two products from one merchant apart', async () => {
    for (const d of monthly('2026-01-03', 4)) await expense('Google', -150, d);
    for (const d of monthly('2026-01-10', 4)) await expense('Google', -50, d);
    await api.post('/api/recurring/detect');
    const rows = (await recurring()).sort((a, b) => a.amount - b.amount);
    expect(rows.map((r) => [r.amount, r.previous_amount, r.occurrences])).toEqual([[-150, null, 4], [-50, null, 4]]);

    // A second run updates both rows instead of merging them into one.
    await api.post('/api/recurring/detect');
    expect(await recurring()).toHaveLength(2);
  });

  it('keeps the active flag when the price changes on a later run', async () => {
    const dates = monthly('2026-01-05', 5);
    for (const d of dates.slice(0, 3)) await expense('Gym', -900, d);
    await api.post('/api/recurring/detect');
    const [row] = (await api.get('/api/recurring')).body as (Row & { id: number })[];
    await api.put(`/api/recurring/${row.id}`, { ...row, active: 0 });
    for (const d of dates.slice(3)) await expense('Gym', -990, d);
    await api.post('/api/recurring/detect');
    const rows = await recurring();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: -990, previous_amount: -900, active: 0 });
  });

  it('ignores a one-off purchase from the same merchant in the middle of the item', async () => {
    const dates = monthly('2026-01-05', 4);
    for (const d of dates) await expense('Apple', -59, d);
    await expense('Apple', -2990, '2026-02-20');
    await api.post('/api/recurring/detect');
    const rows = await recurring();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: -59, previous_amount: null, occurrences: 4 });
  });
});

describe('recurringStatus', () => {
  const item = { active: 1, next_expected: '2026-05-10', frequency: 'Monthly' };
  it('is ok until the expected date', () => {
    expect(recurringStatus(item, '2026-05-10')).toBe('ok');
  });
  it('is overdue within the grace period', () => {
    expect(recurringStatus(item, '2026-05-11')).toBe('overdue');
    expect(recurringStatus(item, '2026-05-17')).toBe('overdue');
  });
  it('is maybe stopped after the grace period', () => {
    expect(recurringStatus(item, '2026-05-18')).toBe('stopped');
    expect(recurringStatus({ ...item, frequency: 'Weekly' }, '2026-05-14')).toBe('stopped');
  });
  it('never flags an inactive item', () => {
    expect(recurringStatus({ ...item, active: 0 }, '2026-09-01')).toBe('ok');
  });
});
