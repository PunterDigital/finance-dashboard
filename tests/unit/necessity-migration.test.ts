import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// A database from before #2818 (no necessity column) upgrades in place and keeps its rows.
describe('necessity migration', () => {
  it('adds the column to an existing database without touching its data', async () => {
    const dir = process.env.FINANCE_DATA_DIR!;
    const old = new DatabaseSync(path.join(dir, 'finance.db'));
    old.exec(`CREATE TABLE transactions (
      id INTEGER PRIMARY KEY, date TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', account TEXT NOT NULL,
      category TEXT, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'CZK', fx_rate REAL, amount_czk REAL,
      type TEXT NOT NULL DEFAULT 'Expense', entity TEXT, notes TEXT, recurring INTEGER NOT NULL DEFAULT 0,
      transfer_pair_id INTEGER, transfer_role TEXT)`);
    old.exec("INSERT INTO transactions (date, description, account, amount, amount_czk) VALUES ('2025-01-02', 'Old row', 'Current', -99, -99)");
    old.close();
    expect(fs.existsSync(path.join(dir, 'finance.db'))).toBe(true);

    const { db } = await import('../../server/db');
    const cols = (db.pragma('table_info(transactions)') as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('necessity');
    expect(db.prepare('SELECT description, amount, necessity FROM transactions').all()).toEqual([
      { description: 'Old row', amount: -99, necessity: null },
    ]);
  });
});
