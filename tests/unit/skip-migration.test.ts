import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// A database from before #3344 (necessity, but no skip columns) upgrades in place: its rows keep
// their data and start out not skipped, so they all stay in the queues.
describe('skip migration', () => {
  it('adds necessity_skipped and category_skipped to an existing database, defaulting to 0', async () => {
    const dir = process.env.FINANCE_DATA_DIR!;
    const old = new DatabaseSync(path.join(dir, 'finance.db'));
    old.exec(`CREATE TABLE transactions (
      id INTEGER PRIMARY KEY, date TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', account TEXT NOT NULL,
      category TEXT, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'CZK', fx_rate REAL, amount_czk REAL,
      type TEXT NOT NULL DEFAULT 'Expense', entity TEXT, notes TEXT, recurring INTEGER NOT NULL DEFAULT 0,
      transfer_pair_id INTEGER, transfer_role TEXT, necessity TEXT)`);
    old.exec(`INSERT INTO transactions (date, description, account, amount, amount_czk, necessity) VALUES
      ('2025-01-02', 'Old unsorted', 'Current', -99, -99, NULL),
      ('2025-01-03', 'Old sorted', 'Current', -50, -50, 'want')`);
    old.close();

    const { db } = await import('../../server/db');
    const cols = (db.pragma('table_info(transactions)') as { name: string; notnull: number; dflt_value: string }[]);
    expect(cols.find((c) => c.name === 'necessity_skipped')).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(cols.find((c) => c.name === 'category_skipped')).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(db.prepare('SELECT description, amount, necessity, necessity_skipped, category_skipped FROM transactions ORDER BY id').all()).toEqual([
      { description: 'Old unsorted', amount: -99, necessity: null, necessity_skipped: 0, category_skipped: 0 },
      { description: 'Old sorted', amount: -50, necessity: 'want', necessity_skipped: 0, category_skipped: 0 },
    ]);

    // The queues run on the upgraded table.
    const { listen } = await import('../../server/index');
    const server = await listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const get = async (url: string) => (await fetch(`http://127.0.0.1:${port}${url}`)).json();
      const sort = await get('/api/necessity/queue');
      expect(sort).toMatchObject({ total: 1, skipped: 0 });
      expect(sort.rows.map((r: any) => r.description)).toEqual(['Old unsorted']);
      expect(await get('/api/category/queue')).toMatchObject({ total: 2, skipped: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
