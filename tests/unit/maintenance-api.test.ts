import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { db, dbPath } from '../../server/db';
import { validateDatabase } from '../../server/maintenance';
import { startApi } from './helpers';

const api = startApi();
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

async function seed() {
  await api.post('/api/accounts', { name: 'Current', type: 'Personal', base_currency: 'CZK', opening_balance: 10 });
  await api.post('/api/categories', { name: 'Groceries', type: 'Expense', grp: 'Living' });
  await api.post('/api/transactions', {
    date: '2026-03-05', description: 'Tesco', account: 'Current', category: 'Groceries', amount: -250, currency: 'CZK', type: 'Expense',
  });
  await api.post('/api/import-templates', { name: 'Wise', config: { mapping: {} } });
}

describe('settings: database backup and reset', () => {
  it('downloads a backup that is a valid Finance Dashboard database', async () => {
    await seed();
    const res = await fetch(api.ctx.base + '/api/maintenance/backup');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="finance-backup-\d{4}-\d{2}-\d{2}\.db"/);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finance-dl-')), 'backup.db');
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    expect(() => validateDatabase(file)).not.toThrow();
    const copy = new DatabaseSync(file, { readOnly: true });
    expect((copy.prepare('SELECT description FROM transactions').get() as { description: string }).description).toBe('Tesco');
    copy.close();
  });

  it('refuses a reset without the typed confirmation or from another origin', async () => {
    expect((await api.post('/api/maintenance/reset', {})).status).toBe(400);
    expect((await api.post('/api/maintenance/reset', { confirm: 'reset' })).status).toBe(400);

    // A cross-site form post: no JSON body, so nothing to confirm with.
    const form = await fetch(api.ctx.base + '/api/maintenance/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'confirm=RESET',
    });
    expect(form.status).toBe(400);

    const foreign = await fetch(api.ctx.base + '/api/maintenance/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ confirm: 'RESET' }),
    });
    expect(foreign.status).toBe(403);
    expect(count('transactions')).toBe(1);
  });

  it('empties every table, keeps a backup, and the app keeps working', async () => {
    const res = await api.post('/api/maintenance/reset', { confirm: 'RESET' });
    expect(res.status).toBe(200);
    expect(path.dirname(res.body.backup)).toBe(path.dirname(dbPath));
    expect(path.basename(res.body.backup)).toMatch(/^finance\.db\.bak-/);

    for (const t of ['accounts', 'categories', 'transactions', 'import_templates']) expect(count(t)).toBe(0);
    const old = new DatabaseSync(res.body.backup, { readOnly: true });
    expect((old.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(1);
    old.close();

    // The old rows are gone from the file itself, not just hidden.
    expect(fs.readFileSync(dbPath).includes('Tesco')).toBe(false);

    // Same connection, fresh ids.
    const acc = await api.post('/api/accounts', { name: 'Fresh', type: 'Personal', base_currency: 'CZK', opening_balance: 0 });
    expect(acc.status).toBe(200);
    expect((await api.get('/api/accounts')).body.map((a: { name: string }) => a.name)).toEqual(['Fresh']);
  });
});
