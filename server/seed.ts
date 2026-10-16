import fs from 'node:fs';
import path from 'node:path';
import xlsx from 'xlsx';
import { db } from './db.js';
import { importWorkbook } from './workbook-import.js';

// One-time migration: financial_tracker.xlsx -> SQLite.
// Re-run with --force to wipe and re-import. Pass a path to read a spreadsheet other than
// ./financial_tracker.xlsx (which is gitignored: it holds real financial data).

const XLSX_PATH = path.resolve(process.argv.slice(2).find((a) => a.endsWith('.xlsx')) ?? 'financial_tracker.xlsx');

const force = process.argv.includes('--force');
const existing = (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as any).n;
if (existing > 0 && !force) {
  console.log(`Database already has ${existing} transactions. Run "npm run seed -- --force" to wipe and re-import.`);
  process.exit(0);
}

const n = importWorkbook(xlsx.read(fs.readFileSync(XLSX_PATH)));

console.log(`Seeded: ${n.transactions} transactions, ${n.accounts} accounts, ${n.categories} categories, ${n.budgets} budget groups, ${n.incomeSources} income sources.`);
