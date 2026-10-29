import { beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// Auto rule proposals (#3490). Made-up CZK rows, so nothing needs an FX rate.
const api = startApi();

let nextDay = 1;
const add = async (description: string, extra: Record<string, unknown> = {}) => {
  const day = String((nextDay++ % 28) + 1).padStart(2, '0');
  return (await api.post('/api/transactions', {
    date: `2026-05-${day}`, description, account: 'Current', amount: -100, currency: 'CZK', type: 'Expense', ...extra,
  })).body.id as number;
};
const setCategory = (id: number, category: string | null) => api.put(`/api/transactions/${id}/category`, { category });
const proposals = async (status = 'pending') =>
  ((await api.get(`/api/suggestions?status=${status}`)).body as any[]).filter((s) => s.kind === 'rule');
const proposalFor = async (text: string, status = 'pending') => (await proposals(status)).find((s) => s.payload.draft.text === text);

beforeAll(async () => {
  await api.post('/api/accounts', { name: 'Current', type: 'Personal', base_currency: 'CZK' });
  await api.post('/api/categories', { name: 'Groceries', type: 'Expense', grp: 'Food' });
  await api.post('/api/categories', { name: 'Eating out', type: 'Expense', grp: 'Food' });
  await api.post('/api/categories', { name: 'Fuel', type: 'Expense', grp: 'Car' });
  await api.post('/api/categories', { name: 'Salary', type: 'Income', grp: 'Work' });
});

describe('auto rule proposals', () => {
  it('proposes an exact rule on the third hand-set category, not before', async () => {
    // Case and spacing differ: the description is matched normalised.
    const ids = [await add('Lidl Praha'), await add('LIDL  praha'), await add('lidl praha'), await add('Lidl Praha')];
    await setCategory(ids[0], 'Groceries');
    await setCategory(ids[1], 'Groceries');
    expect(await proposalFor('lidl praha')).toBeUndefined();
    await setCategory(ids[2], 'Groceries');
    const p = await proposalFor('lidl praha');
    expect(p).toBeTruthy();
    expect(p.payload).toMatchObject({
      author: 'auto',
      draft: { match: 'exact', text: 'lidl praha', account: null, type: 'Expense', amount_min: null, amount_max: null, category: 'Groceries' },
    });
    expect(p.payload.reason).toContain('3 times');
    // A fourth one doesn't add a second proposal.
    await setCategory(ids[3], 'Groceries');
    expect((await proposals()).filter((s) => s.payload.draft.text === 'lidl praha')).toHaveLength(1);
  });

  it('accepting creates an auto rule that categorises the remaining rows', async () => {
    const rest = await add('Lidl Praha');
    const p = await proposalFor('lidl praha');
    const res = await api.post(`/api/suggestions/${p.id}/accept`);
    expect(res.status).toBe(200);
    expect(res.body.result.applied).toBe(1);
    const rule = ((await api.get('/api/rules')).body as any[]).find((r) => r.rule_id === res.body.result.rule_id);
    expect(rule).toMatchObject({ text: 'lidl praha', category: 'Groceries', author: 'auto' });
    const row = ((await api.get('/api/transactions?limit=500')).body.rows as any[]).find((r) => r.id === rest);
    expect(row).toMatchObject({ category: 'Groceries', category_source: 'rule' });
  });

  it('makes no proposal when a rule already matches those rows', async () => {
    await api.post('/api/rules', { draft: { match: 'contains', text: 'shell', account: null, type: 'Expense', amount_min: null, amount_max: null, category: 'Fuel' } });
    // The rule set these, so the user overrides them by hand.
    const ids = [await add('Shell D1'), await add('Shell D1'), await add('Shell D1')];
    for (const id of ids) await setCategory(id, 'Groceries');
    expect(await proposalFor('shell d1')).toBeUndefined();
  });

  it('does not propose a rejected proposal again, but can propose another category', async () => {
    const ids = [await add('Cafe Louvre'), await add('Cafe Louvre'), await add('Cafe Louvre')];
    for (const id of ids) await setCategory(id, 'Groceries');
    const first = await proposalFor('cafe louvre');
    expect(first.payload.draft.category).toBe('Groceries');
    expect((await api.post(`/api/suggestions/${first.id}/reject`)).status).toBe(200);

    // Clearing and setting the same category again doesn't bring it back.
    await setCategory(ids[0], null);
    await setCategory(ids[0], 'Groceries');
    expect(await proposalFor('cafe louvre')).toBeUndefined();

    // The user changes their mind: three times Eating out (more than Groceries' two) is a new proposal.
    for (const id of ids) await setCategory(id, 'Eating out');
    const second = await proposalFor('cafe louvre');
    expect(second.payload.draft.category).toBe('Eating out');
  });

  it('needs the category to lead: a tie or a minority proposes nothing', async () => {
    const ids = await Promise.all([1, 2, 3, 4, 5, 6].map(() => add('Tesco Express')));
    for (const id of ids.slice(0, 3)) await setCategory(id, 'Groceries');
    const p = await proposalFor('tesco express');
    await api.post(`/api/suggestions/${p.id}/reject`);
    for (const id of ids.slice(3)) await setCategory(id, 'Eating out');
    expect(await proposalFor('tesco express')).toBeUndefined();
  });

  it('counts only categories set by hand and never transfers', async () => {
    // Categories imported with a CSV are not "by hand".
    const row = (date: string) => ({ date, description: 'Billa', account: 'Current', amount: -50, currency: 'CZK', type: 'Expense', category: 'Groceries' });
    expect((await api.post('/api/import', { rows: [row('2026-06-01'), row('2026-06-02')] })).body.inserted).toBe(2);
    const id = await add('Billa');
    await setCategory(id, 'Groceries');
    expect(await proposalFor('billa')).toBeUndefined();

    const t = [1, 2, 3].map(() => add('Revolut top up', { type: 'Transfer' }));
    await Promise.all(t);
    expect(await proposalFor('revolut top up')).toBeUndefined();
  });

  it('works for income, from the editor and from a manual add', async () => {
    await add('ACME s.r.o. salary', { type: 'Income', amount: 5000, category: 'Salary' });
    await add('ACME s.r.o. salary', { type: 'Income', amount: 5000, category: 'Salary' });
    const id = await add('ACME s.r.o. salary', { type: 'Income', amount: 5000 });
    expect(await proposalFor('acme s.r.o. salary')).toBeUndefined();
    const row = ((await api.get('/api/transactions?limit=500')).body.rows as any[]).find((r) => r.id === id);
    expect((await api.put(`/api/transactions/${id}`, { ...row, category: 'Salary' })).status).toBe(200);
    expect((await proposalFor('acme s.r.o. salary'))?.payload.draft).toMatchObject({ type: 'Income', category: 'Salary' });
  });
});
