import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// A database from before #3488 upgrades in place. Its categories can't be told apart, so they all
// count as the user's, and the rules never change them.
describe('rules migration', () => {
  it('adds category_source (existing categories = user) and the rule tables', async () => {
    const dir = process.env.FINANCE_DATA_DIR!;
    const old = new DatabaseSync(path.join(dir, 'finance.db'));
    old.exec(`CREATE TABLE transactions (
      id INTEGER PRIMARY KEY, date TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', account TEXT NOT NULL,
      category TEXT, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'CZK', fx_rate REAL, amount_czk REAL,
      type TEXT NOT NULL DEFAULT 'Expense', entity TEXT, notes TEXT, recurring INTEGER NOT NULL DEFAULT 0)`);
    old.exec(`INSERT INTO transactions (date, description, account, category, amount, amount_czk) VALUES
      ('2025-01-02', 'Albert', 'Current', 'Groceries', -99, -99),
      ('2025-01-03', 'Albert', 'Current', NULL, -50, -50),
      ('2025-01-04', 'Albert', 'Current', ' ', -40, -40)`);
    old.close();

    const { db } = await import('../../server/db');
    expect(db.prepare('SELECT category, category_source, category_rule_id FROM transactions ORDER BY id').all()).toEqual([
      { category: 'Groceries', category_source: 'user', category_rule_id: null },
      { category: null, category_source: null, category_rule_id: null },
      { category: ' ', category_source: null, category_rule_id: null },
    ]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['rules', 'rule_versions', 'rule_audit']));
  });
});
