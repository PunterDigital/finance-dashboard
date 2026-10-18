import { beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

const api = startApi();

// Made-up CZK rows, so nothing needs an FX rate.
const ids: Record<string, number> = {};
beforeAll(async () => {
  await api.post('/api/accounts', { name: 'Current', type: 'Personal', base_currency: 'CZK' });
  const add = async (key: string, t: Record<string, unknown>) => {
    ids[key] = (await api.post('/api/transactions', { account: 'Current', currency: 'CZK', type: 'Expense', ...t })).body.id;
  };
  await add('rent', { date: '2026-05-01', description: 'Rent', amount: -15000 });
  await add('cinema', { date: '2026-05-10', description: 'Cinema', amount: -400 });
  await add('groceries', { date: '2026-05-20', description: 'Groceries', amount: -1600 });
  await add('salary', { date: '2026-05-25', description: 'Salary', amount: 60000, type: 'Income' });
  await add('transfer', { date: '2026-05-26', description: 'To savings', amount: -5000, type: 'Transfer' });
});

describe('need / want', () => {
  it('queues unsorted expenses newest first, leaving out income and transfers', async () => {
    const q = await api.get('/api/necessity/queue');
    expect(q.body.total).toBe(3);
    expect(q.body.rows.map((r: any) => r.description)).toEqual(['Groceries', 'Cinema', 'Rent']);
    expect(q.body.rows[0].necessity).toBeNull();
  });

  it('leaves out skipped ids but still counts them', async () => {
    const q = await api.get(`/api/necessity/queue?exclude=${ids.groceries},${ids.cinema}`);
    expect(q.body.rows.map((r: any) => r.description)).toEqual(['Rent']);
    expect(q.body.total).toBe(3);
  });

  it('marks expenses need or want and drops them from the queue', async () => {
    const rent = await api.put(`/api/transactions/${ids.rent}/necessity`, { necessity: 'need' });
    expect(rent.status).toBe(200);
    expect(rent.body.necessity).toBe('need');
    await api.put(`/api/transactions/${ids.cinema}/necessity`, { necessity: 'want' });
    await api.put(`/api/transactions/${ids.groceries}/necessity`, { necessity: 'need' });
    expect((await api.get('/api/necessity/queue')).body.total).toBe(0);
  });

  it('filters the transaction list by need, want and unsorted', async () => {
    const names = async (q: string) => (await api.get(`/api/transactions?necessity=${q}`)).body.rows.map((r: any) => r.description);
    expect(await names('need')).toEqual(['Groceries', 'Rent']);
    expect(await names('want')).toEqual(['Cinema']);
    expect(await names('unsorted')).toEqual([]);
  });

  it('splits the month on the dashboard (CZK totals and shares)', async () => {
    const { necessity } = (await api.get('/api/reports/overview?month=2026-05')).body;
    expect(necessity).toMatchObject({ need: 16600, want: 400, unsorted: 0, needCount: 2, wantCount: 1, unsortedCount: 0 });
    expect(necessity.needShare).toBeCloseTo(16600 / 17000);
    expect(necessity.wantShare).toBeCloseTo(400 / 17000);
  });

  it('clears a choice with null (undo)', async () => {
    const res = await api.put(`/api/transactions/${ids.cinema}/necessity`, { necessity: null });
    expect(res.body.necessity).toBeNull();
    const q = await api.get('/api/necessity/queue');
    expect(q.body.rows.map((r: any) => r.description)).toEqual(['Cinema']);
    const { necessity } = (await api.get('/api/reports/overview?month=2026-05')).body;
    expect(necessity).toMatchObject({ want: 0, unsorted: 400, unsortedCount: 1, needShare: 1 });
  });

  it('refuses bad values, missing rows and non-expenses', async () => {
    expect((await api.put(`/api/transactions/${ids.rent}/necessity`, { necessity: 'maybe' })).status).toBe(400);
    expect((await api.put('/api/transactions/999999/necessity', { necessity: 'need' })).status).toBe(404);
    expect((await api.put(`/api/transactions/${ids.salary}/necessity`, { necessity: 'need' })).status).toBe(400);
    expect((await api.put(`/api/transactions/${ids.transfer}/necessity`, { necessity: 'want' })).status).toBe(400);
  });

  it('keeps the choice through a normal edit, and drops it when the row stops being an expense', async () => {
    const rent = (await api.get('/api/transactions?necessity=need')).body.rows.find((r: any) => r.id === ids.rent);
    const edited = await api.put(`/api/transactions/${ids.rent}`, { ...rent, description: 'Rent (May)' });
    expect(edited.body.necessity).toBe('need');
    const asIncome = await api.put(`/api/transactions/${ids.rent}`, { ...edited.body, type: 'Income', amount: 15000 });
    expect(asIncome.body.necessity).toBeNull();
  });
});
