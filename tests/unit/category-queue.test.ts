import { beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

const api = startApi();

// Made-up CZK rows, so nothing needs an FX rate.
const ids: Record<string, number> = {};
beforeAll(async () => {
  await api.post('/api/accounts', { name: 'Current', type: 'Personal', base_currency: 'CZK' });
  await api.post('/api/categories', { name: 'Groceries', type: 'Expense', grp: 'Food' });
  await api.post('/api/categories', { name: 'Eating out', type: 'Expense', grp: 'Food' });
  await api.post('/api/categories', { name: 'Salary', type: 'Income', grp: 'Work' });
  const add = async (key: string, t: Record<string, unknown>) => {
    ids[key] = (await api.post('/api/transactions', { account: 'Current', currency: 'CZK', type: 'Expense', ...t })).body.id;
  };
  // History that the suggestions learn from: Albert is mostly Groceries, once Eating out.
  await add('old1', { date: '2026-04-01', description: 'Albert', amount: -500, category: 'Groceries' });
  await add('old2', { date: '2026-04-08', description: 'albert ', amount: -700, category: 'Groceries' });
  await add('old3', { date: '2026-04-15', description: 'Albert', amount: -90, category: 'Eating out' });
  await add('zabkaOld', { date: '2026-04-20', description: 'Žabka', amount: -120, category: 'Eating out' });
  await add('zabka', { date: '2026-05-01', description: 'ŽABKA', amount: -80 });
  await add('albert', { date: '2026-05-02', description: 'ALBERT', amount: -650 });
  await add('kiosk', { date: '2026-05-03', description: 'Kiosk', amount: -40, category: '' });
  await add('salary', { date: '2026-05-25', description: 'Salary', amount: 60000, type: 'Income' });
  await add('transfer', { date: '2026-05-26', description: 'To savings', amount: -5000, type: 'Transfer' });
});

describe('assign categories', () => {
  it('queues uncategorised income and expenses newest first, leaving out transfers', async () => {
    const q = await api.get('/api/category/queue');
    expect(q.body.total).toBe(4);
    expect(q.body.rows.map((r: any) => r.description)).toEqual(['Salary', 'Kiosk', 'ALBERT', 'ŽABKA']);
  });

  it('suggests the category most often used for the same description and type', async () => {
    const rows = (await api.get('/api/category/queue')).body.rows;
    const by = (d: string) => rows.find((r: any) => r.description === d).suggestion;
    expect(by('ALBERT')).toBe('Groceries');
    expect(by('ŽABKA')).toBe('Eating out'); // case folding beyond ASCII
    expect(by('Kiosk')).toBeNull();
    expect(by('Salary')).toBeNull();
  });

  it('leaves out skipped ids but still counts them', async () => {
    const q = await api.get(`/api/category/queue?exclude=${ids.salary},${ids.kiosk},${ids.zabka}`);
    expect(q.body.rows.map((r: any) => r.description)).toEqual(['ALBERT']);
    expect(q.body.total).toBe(4);
  });

  it('assigns categories and drops the rows from the queue', async () => {
    const res = await api.put(`/api/transactions/${ids.albert}/category`, { category: 'Groceries' });
    expect(res.status).toBe(200);
    expect(res.body.category).toBe('Groceries');
    await api.put(`/api/transactions/${ids.salary}/category`, { category: 'Salary' });
    const q = await api.get('/api/category/queue');
    expect(q.body.rows.map((r: any) => r.description)).toEqual(['Kiosk', 'ŽABKA']);
    expect(q.body.total).toBe(2);
  });

  it('counts the new categories in the category report', async () => {
    const { categories } = (await api.get('/api/reports/categories?month=2026-05')).body;
    expect(categories.find((c: any) => c.category === 'Groceries')).toMatchObject({ grp: 'Food', total: 650, count: 1 });
  });

  it('clears a category with null (undo)', async () => {
    const res = await api.put(`/api/transactions/${ids.albert}/category`, { category: null });
    expect(res.body.category).toBeNull();
    expect((await api.get('/api/category/queue')).body.total).toBe(3);
  });

  it('refuses unknown categories, the wrong type, transfers, bad values and missing rows', async () => {
    expect((await api.put(`/api/transactions/${ids.kiosk}/category`, { category: 'Nope' })).status).toBe(400);
    expect((await api.put(`/api/transactions/${ids.kiosk}/category`, { category: 'Salary' })).status).toBe(400);
    expect((await api.put(`/api/transactions/${ids.salary}/category`, { category: 'Groceries' })).status).toBe(400);
    expect((await api.put(`/api/transactions/${ids.transfer}/category`, { category: 'Groceries' })).status).toBe(400);
    expect((await api.put(`/api/transactions/${ids.kiosk}/category`, { category: 42 })).status).toBe(400);
    expect((await api.put('/api/transactions/999999/category', { category: 'Groceries' })).status).toBe(404);
    const kiosk = (await api.get('/api/transactions?search=Kiosk')).body.rows[0];
    expect(kiosk.category).toBe('');
  });
});
