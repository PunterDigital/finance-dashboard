import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

  it('saves a skip in the database: the row leaves the queue but is still counted (#3344)', async () => {
    for (const key of ['salary', 'kiosk', 'zabka']) {
      const res = await api.put(`/api/transactions/${ids[key]}/category-skip`, { skipped: true });
      expect(res.status).toBe(200);
      expect(res.body.category_skipped).toBe(1);
    }
    const q = await api.get('/api/category/queue');
    expect(q.body.rows.map((r: any) => r.description)).toEqual(['ALBERT']);
    expect(q.body).toMatchObject({ total: 4, skipped: 3 });

    // On disk, so a restart (a new connection to the same file) still sees it.
    const file = new DatabaseSync(path.join(process.env.FINANCE_DATA_DIR!, 'finance.db'));
    const skipped = file.prepare('SELECT description FROM transactions WHERE category_skipped = 1 ORDER BY date').all();
    file.close();
    expect(skipped.map((r: any) => r.description)).toEqual(['ŽABKA', 'Kiosk', 'Salary']);
  });

  it('"Review skipped" clears every skip', async () => {
    const cleared = await api.post('/api/category/skips/clear');
    expect(cleared.body).toEqual({ cleared: 3 });
    const q = await api.get('/api/category/queue');
    expect(q.body.rows.map((r: any) => r.description)).toEqual(['Salary', 'Kiosk', 'ALBERT', 'ŽABKA']);
    expect(q.body).toMatchObject({ total: 4, skipped: 0 });
  });

  it('assigning a category clears the skip, in the picker and in the editor', async () => {
    await api.put(`/api/transactions/${ids.albert}/category-skip`, { skipped: true });
    const picked = await api.put(`/api/transactions/${ids.albert}/category`, { category: 'Groceries' });
    expect(picked.body).toMatchObject({ category: 'Groceries', category_skipped: 0 });
    await api.put(`/api/transactions/${ids.albert}/category`, { category: null });

    const zabka = (await api.put(`/api/transactions/${ids.zabka}/category-skip`, { skipped: true })).body;
    const edited = await api.put(`/api/transactions/${ids.zabka}`, { ...zabka, category: 'Eating out' });
    expect(edited.body).toMatchObject({ category: 'Eating out', category_skipped: 0 });
    await api.put(`/api/transactions/${ids.zabka}/category`, { category: null });

    expect((await api.get('/api/category/queue')).body).toMatchObject({ total: 4, skipped: 0 });
  });

  it('refuses bad skip values, missing rows and transfers', async () => {
    expect((await api.put(`/api/transactions/${ids.kiosk}/category-skip`, { skipped: 1 })).status).toBe(400);
    expect((await api.put('/api/transactions/999999/category-skip', { skipped: true })).status).toBe(404);
    expect((await api.put(`/api/transactions/${ids.transfer}/category-skip`, { skipped: true })).status).toBe(400);
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
