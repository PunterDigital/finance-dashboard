import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'finance.db'));
db.pragma('journal_mode = WAL');

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
