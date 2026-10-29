import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { startApi } from './helpers';

const api = startApi();

describe('host guard', () => {
  it('rejects requests whose Host header is not loopback (DNS rebinding)', async () => {
    const { port } = new URL(api.ctx.base);
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/accounts', headers: { Host: 'evil.example:80' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject);
    });
    expect(status).toBe(403);
  });

  it('allows loopback hosts', async () => {
    expect((await api.get('/api/accounts')).status).toBe(200);
  });
});

describe('accounts, categories and transactions', () => {
  it('creates, lists, edits and deletes a CZK transaction without touching the network', async () => {
    await api.post('/api/accounts', { name: 'Current', type: 'Personal', base_currency: 'CZK', opening_balance: 1000 });
    await api.post('/api/categories', { name: 'Groceries', type: 'Expense', grp: 'Living' });

    const created = await api.post('/api/transactions', {
      date: '2026-03-05', description: 'Tesco', account: 'Current', category: 'Groceries',
      amount: -250, currency: 'CZK', type: 'Expense',
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ fx_rate: 1, amount_czk: -250, description: 'Tesco' });

    const list = await api.get('/api/transactions?month=2026-03');
    expect(list.body.total).toBe(1);
    expect(list.body.rows[0].id).toBe(created.body.id);

    const edited = await api.put(`/api/transactions/${created.body.id}`, { ...created.body, amount: -300 });
    expect(edited.body.amount_czk).toBe(-300);

    const report = await api.get('/api/reports/overview?month=2026-03');
    expect(report.body.kpis.expenses).toBe(300);
    expect(report.body.topCategories[0]).toMatchObject({ category: 'Groceries', total: 300 });

    await api.del(`/api/transactions/${created.body.id}`);
    expect((await api.get('/api/transactions?month=2026-03')).body.total).toBe(0);
  });

  it('flags duplicates on CSV import check', async () => {
    const row = { date: '2026-04-01', description: 'Rent', account: 'Current', amount: -15000, currency: 'CZK', type: 'Expense' };
    expect((await api.post('/api/import', { rows: [row] })).body).toEqual({ inserted: 1, fxMissing: 0, categorised: 0 });
    const check = await api.post('/api/import/check', { rows: [row, { ...row, description: 'Other' }] });
    expect(check.body).toEqual([
      { duplicate: true, duplicateInBatch: false },
      { duplicate: false, duplicateInBatch: false },
    ]);
  });

  it('rolls back a failed transaction block', async () => {
    const { db } = await import('../../server/db');
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
    const before = count();
    const failing = db.transaction(() => {
      db.prepare("INSERT INTO accounts (name) VALUES ('Temp')").run();
      throw new Error('boom');
    });
    expect(failing).toThrow('boom');
    expect(count()).toBe(before);
  });
});
