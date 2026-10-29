import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

// FINANCE_DATA_DIR is set by the desktop app (its userData folder) and by tests (a temp dir).
// Dev scripts run from the repo root, so the default is ./data.
export const dataDir = path.resolve(process.env.FINANCE_DATA_DIR ?? 'data');
fs.mkdirSync(dataDir, { recursive: true });
export const dbPath = path.join(dataDir, 'finance.db');

// Rows come back as `unknown` (like better-sqlite3) so callers cast them to their own row types.
export interface Statement {
  run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SQLInputValue[]): unknown;
  all(...params: SQLInputValue[]): unknown[];
}

// Thin better-sqlite3-style wrapper over the built-in node:sqlite, so there is no native module to
// rebuild for Electron. Only the parts this app uses: prepare/exec/pragma/transaction/close.
class Db {
  private depth = 0;
  constructor(readonly raw: DatabaseSync) {}

  prepare(sql: string): Statement {
    return this.raw.prepare(sql);
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }

  pragma(sql: string): unknown[] {
    return this.raw.prepare(`PRAGMA ${sql}`).all();
  }

  // Savepoints instead of BEGIN so transactions nest, like better-sqlite3.
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      const sp = `sp_${++this.depth}`;
      this.raw.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn(...args);
        this.raw.exec(`RELEASE ${sp}`);
        return result;
      } catch (err) {
        this.raw.exec(`ROLLBACK TO ${sp}`);
        this.raw.exec(`RELEASE ${sp}`);
        throw err;
      } finally {
        this.depth--;
      }
    };
  }

  close() {
    if (this.raw.isOpen) this.raw.close();
  }
}

export type { SQLInputValue };
export const db = new Db(new DatabaseSync(dbPath));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL DEFAULT 'Personal',
  entity TEXT,
  base_currency TEXT NOT NULL DEFAULT 'CZK',
  opening_balance REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL DEFAULT 'Expense',
  grp TEXT NOT NULL DEFAULT 'Other'
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL,
  category TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CZK',
  fx_rate REAL,
  amount_czk REAL,
  type TEXT NOT NULL DEFAULT 'Expense',
  entity TEXT,
  notes TEXT,
  recurring INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category);

CREATE TABLE IF NOT EXISTS fx_rates (
  date TEXT NOT NULL,
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (date, base, quote)
);

CREATE TABLE IF NOT EXISTS import_templates (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budgets (
  grp TEXT PRIMARY KEY,
  monthly_czk REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS income_sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  amount REAL,
  currency TEXT NOT NULL DEFAULT 'CZK',
  rate_to_czk REAL,
  monthly_czk REAL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS recurring (
  id INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  amount REAL,
  currency TEXT,
  account TEXT,
  category TEXT,
  frequency TEXT,
  last_seen TEXT,
  next_expected TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  occurrences INTEGER NOT NULL DEFAULT 0
);
`);

// Column migrations for databases created before transfer pairing existed.
const txCols = (db.pragma('table_info(transactions)') as { name: string }[]).map((c) => c.name);
if (!txCols.includes('transfer_pair_id')) {
  db.exec('ALTER TABLE transactions ADD COLUMN transfer_pair_id INTEGER');
}
if (!txCols.includes('transfer_role')) {
  // 'out' | 'in' | NULL (unresolved — excluded from balances until reviewed)
  db.exec("ALTER TABLE transactions ADD COLUMN transfer_role TEXT");
}
if (!txCols.includes('necessity')) {
  // 'need' | 'want' | NULL (not sorted yet). Only expenses are sorted (#2818).
  db.exec('ALTER TABLE transactions ADD COLUMN necessity TEXT');
}
// 1 = skipped on the need/want sorter or the category picker; the queues leave those rows out until
// "Review skipped" clears the flags (#3344). Making a choice clears the row's flag.
if (!txCols.includes('necessity_skipped')) {
  db.exec('ALTER TABLE transactions ADD COLUMN necessity_skipped INTEGER NOT NULL DEFAULT 0');
}
if (!txCols.includes('category_skipped')) {
  db.exec('ALTER TABLE transactions ADD COLUMN category_skipped INTEGER NOT NULL DEFAULT 0');
}
// Who set a row's category (#3488): 'user', 'rule', 'llm' or 'import'; NULL while it has none. A rule
// never changes a 'user' category. Categories that existed before this column can't be told apart,
// so they count as 'user' (rules leave them alone). A rule-set row also records the rule and version,
// so a rollback finds the rows that rule set.
if (!txCols.includes('category_source')) {
  db.exec('ALTER TABLE transactions ADD COLUMN category_source TEXT');
  db.exec("UPDATE transactions SET category_source='user' WHERE category IS NOT NULL AND trim(category) != ''");
}
if (!txCols.includes('category_rule_id')) {
  db.exec('ALTER TABLE transactions ADD COLUMN category_rule_id INTEGER');
}
if (!txCols.includes('category_rule_version')) {
  db.exec('ALTER TABLE transactions ADD COLUMN category_rule_version INTEGER');
}

// Category rules (#3488, server/rules.ts). rule_versions is append-only: an edit, a rollback or a
// category rename writes a new version and moves rules.current_version. rule_audit logs every change.
db.exec(`
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  current_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rule_versions (
  rule_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  match TEXT NOT NULL,
  text TEXT NOT NULL,
  account TEXT,
  type TEXT NOT NULL,
  amount_min REAL,
  amount_max REAL,
  category TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rule_id, version)
);
CREATE TRIGGER IF NOT EXISTS rule_versions_append_only BEFORE UPDATE ON rule_versions
BEGIN SELECT RAISE(ABORT, 'rule_versions is append-only'); END;

CREATE TABLE IF NOT EXISTS rule_audit (
  id INTEGER PRIMARY KEY,
  rule_id INTEGER NOT NULL,
  version INTEGER,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_category_rule ON transactions(category_rule_id);

-- Suggestions waiting for the user in the Inbox (#3489, server/suggestions.ts). Nothing changes the
-- data until one is accepted. model / prompt_version / run_id are for LLM-made suggestions.
CREATE TABLE IF NOT EXISTS agent_suggestions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  model TEXT,
  prompt_version TEXT,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON agent_suggestions(status);
`);

// The amount before the latest price change of a recurring item, and the date of the first payment
// at the new price (#3487). Both NULL when the price never changed.
const recurringCols = (db.pragma('table_info(recurring)') as { name: string }[]).map((c) => c.name);
if (!recurringCols.includes('previous_amount')) {
  db.exec('ALTER TABLE recurring ADD COLUMN previous_amount REAL');
}
if (!recurringCols.includes('price_changed_on')) {
  db.exec('ALTER TABLE recurring ADD COLUMN price_changed_on TEXT');
}
