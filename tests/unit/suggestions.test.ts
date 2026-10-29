import { beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';
import { suggestFromRecurring } from '../../server/suggestions';

const api = startApi();

// Made-up CZK rows, so nothing needs an FX rate.
const draft = (over: Record<string, unknown> = {}) => ({
  match: 'contains', text: 'albert', account: null, type: 'Expense', amount_min: null, amount_max: null, category: 'Groceries', ...over,
});
const monthsAgo = (n: number, day: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCDate(day);
  return d.toISOString().slice(0, 10);
};
const status = async (id: number) => {
  for (const s of ['pending', 'accepted', 'rejected', 'edited', 'expired']) {
    const hit = ((await api.get(`/api/suggestions?status=${s}`)).body as any[]).find((x) => x.id === id);
    if (hit) return hit;
  }
  return null;
};

beforeAll(async () => {
  await api.post('/api/accounts', { name: 'Current', type: 'Personal', base_currency: 'CZK' });
  await api.post('/api/categories', { name: 'Groceries', type: 'Expense', grp: 'Food' });
  await api.post('/api/categories', { name: 'Eating out', type: 'Expense', grp: 'Food' });
  const tx = (date: string, description: string, amount: number) =>
    api.post('/api/transactions', { date, description, account: 'Current', amount, currency: 'CZK', type: 'Expense' });
  await tx('2026-05-01', 'Albert', -500);
  await tx('2026-05-02', 'Albert Praha', -90);
  // Dates count back from today, since "maybe stopped" depends on it. Streamy: 199 a month, then 249
  // for the last three months (a price change). Gym: monthly until five months ago, then nothing.
  for (const n of [5, 4, 3]) await tx(monthsAgo(n, 1), 'Streamy', -199);
  for (const n of [2, 1, 0]) await tx(monthsAgo(n, 1), 'Streamy', -249);
  for (const n of [9, 8, 7, 6, 5]) await tx(monthsAgo(n, 10), 'Gym Club', -900);
});

describe('suggestions API', () => {
  it('starts empty and refuses a bad suggestion', async () => {
    expect((await api.get('/api/suggestions')).body).toEqual([]);
    expect((await api.get('/api/suggestions/count')).body).toEqual({ pending: 0 });
    expect((await api.post('/api/suggestions', { kind: 'Bad Kind!', payload: {} })).status).toBe(400);
    expect((await api.post('/api/suggestions', { kind: 'rule', payload: [] })).status).toBe(400);
    expect((await api.post('/api/suggestions', { kind: 'rule', payload: { draft: draft({ category: 'Nope' }) } })).status).toBe(400);
    expect((await api.get('/api/suggestions?status=bogus')).status).toBe(400);
  });

  it('accepting a rule suggestion creates and applies the rule', async () => {
    const { id } = (await api.post('/api/suggestions', { kind: 'rule', payload: { draft: draft(), reason: 'seen 3 times' }, model: 'm', run_id: 'r1' })).body;
    expect((await api.get('/api/suggestions/count')).body).toEqual({ pending: 1 });
    const res = await api.post(`/api/suggestions/${id}/accept`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'accepted', result: { applied: 2 } });
    const s = await status(id);
    expect(s).toMatchObject({ status: 'accepted', model: 'm', run_id: 'r1' });
    expect(s.decided_at).toBeTruthy();

    const rule = (await api.get(`/api/rules/${res.body.result.rule_id}`)).body;
    expect(rule.versions[0]).toMatchObject({ author: 'auto', category: 'Groceries' });
    expect(rule.audit.map((a: any) => [a.action, a.actor])).toEqual([['accept', 'user'], ['create', 'auto']]);

    // Decided once only.
    expect((await api.post(`/api/suggestions/${id}/accept`)).status).toBe(409);
    expect((await api.post(`/api/suggestions/${id}/reject`)).status).toBe(409);
    expect((await api.get('/api/suggestions/count')).body).toEqual({ pending: 0 });
  });

  it('Edit accepts the user\'s version and keeps both in the payload', async () => {
    const { id } = (await api.post('/api/suggestions', { kind: 'rule', payload: { draft: draft({ match: 'exact', text: 'albert praha' }) } })).body;
    const res = await api.post(`/api/suggestions/${id}/accept`, { payload: { draft: draft({ match: 'exact', text: 'albert praha', category: 'Eating out' }) } });
    expect(res.body).toMatchObject({ status: 'edited', result: { applied: 1 } });
    const s = await status(id);
    expect(s.payload.draft.category).toBe('Groceries');
    expect(s.payload.edited.draft.category).toBe('Eating out');
    // A bad edit is refused and the suggestion stays pending.
    const other = (await api.post('/api/suggestions', { kind: 'rule', payload: { draft: draft({ text: 'shell' }) } })).body.id;
    expect((await api.post(`/api/suggestions/${other}/accept`, { payload: { draft: draft({ category: 'Nope' }) } })).status).toBe(400);
    expect((await status(other)).status).toBe('pending');
    expect((await api.post(`/api/suggestions/${other}/reject`)).body).toEqual({ id: other, status: 'rejected' });
  });

  it('an unknown kind can only be rejected', async () => {
    const { id } = (await api.post('/api/suggestions', { kind: 'digest', payload: { text: '<b>hi</b>' } })).body;
    const res = await api.post(`/api/suggestions/${id}/accept`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/can only be rejected/);
    expect((await api.post(`/api/suggestions/${id}/reject`)).status).toBe(200);
  });

  it('recurring detection leaves a price-change and a maybe-stopped notice, once', async () => {
    const first = await api.post('/api/recurring/detect');
    expect(first.body.suggestions).toBe(2);
    const pending = (await api.get('/api/suggestions')).body as any[];
    const price = pending.find((s) => s.kind === 'price_change');
    const stopped = pending.find((s) => s.kind === 'recurring_stopped');
    expect(price.payload).toMatchObject({ description: 'Streamy', previous_amount: -199, amount: -249, changed_on: monthsAgo(2, 1) });
    expect(stopped.payload).toMatchObject({ description: 'Gym Club', last_seen: monthsAgo(5, 10) });
    expect((await api.post('/api/recurring/detect')).body.suggestions).toBe(0);

    // Accepting "stopped" marks the item inactive; a price change is acknowledged.
    expect((await api.post(`/api/suggestions/${stopped.id}/accept`)).status).toBe(200);
    const gym = ((await api.get('/api/recurring')).body as any[]).find((r) => r.description === 'Gym Club');
    expect(gym.active).toBe(0);
    expect((await api.post(`/api/suggestions/${price.id}/reject`)).status).toBe(200);
    // Rejected notices don't come back.
    expect((await api.post('/api/recurring/detect')).body.suggestions).toBe(0);
  });

  it('a notice whose item is gone expires on accept, and one that no longer holds expires on the next detection', async () => {
    const { id } = (await api.post('/api/suggestions', { kind: 'recurring_stopped', payload: { recurring_id: 9999, description: 'Gone' } })).body;
    const res = await api.post(`/api/suggestions/${id}/accept`);
    expect(res.status).toBe(409);
    expect((await status(id)).status).toBe('expired');

    const items = (await api.get('/api/recurring')).body as any[];
    const streamy = items.find((r) => r.description === 'Streamy');
    const stale = (await api.post('/api/suggestions', { kind: 'recurring_stopped', payload: { key: 'stopped:streamy:test', recurring_id: streamy.id } })).body.id;
    // Streamy isn't stopped, so the notice no longer holds.
    expect(suggestFromRecurring(new Date().toISOString().slice(0, 10)).expired).toBe(1);
    expect((await status(stale)).status).toBe('expired');
  });
});
