import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';
import { db } from './db.js';

// One-time migration: financial_tracker.xlsx -> SQLite.
// Re-run with --force to wipe and re-import.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XLSX_PATH = path.join(__dirname, '..', 'financial_tracker.xlsx');

const force = process.argv.includes('--force');
const existing = (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as any).n;
if (existing > 0 && !force) {
  console.log(`Database already has ${existing} transactions. Run "npm run seed -- --force" to wipe and re-import.`);
  process.exit(0);
}

const wb = xlsx.readFile(XLSX_PATH);

function sheetRows(name: string): any[][] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as any[][];
}

// Excel serial / string / Date -> YYYY-MM-DD
function toDateStr(v: any): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const parsed = new Date(s);
  return isNaN(+parsed) ? null : parsed.toISOString().slice(0, 10);
}

const wipe = db.transaction(() => {
  for (const t of ['transactions', 'accounts', 'categories', 'budgets', 'income_sources', 'recurring']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});
wipe();

// ---- Accounts (header row 3, data from row 4) ----
const accRows = sheetRows('Accounts').slice(3);
const insAcc = db.prepare('INSERT OR IGNORE INTO accounts (name, type, entity, base_currency, opening_balance) VALUES (?,?,?,?,?)');
let nAcc = 0;
for (const r of accRows) {
  if (!r?.[0]) continue;
  insAcc.run(String(r[0]).trim(), r[1] ?? 'Personal', r[2] ?? null, r[3] ?? 'CZK', Number(r[4]) || 0);
  nAcc++;
}

// ---- Categories (header row 3, data from row 4) ----
const catRows = sheetRows('Categories').slice(3);
const insCat = db.prepare('INSERT OR IGNORE INTO categories (name, type, grp) VALUES (?,?,?)');
let nCat = 0;
for (const r of catRows) {
  if (!r?.[0]) continue;
  insCat.run(String(r[0]).trim(), r[1] ?? 'Expense', r[2] ?? 'Other');
  nCat++;
}

// ---- Transactions (header row 4, data from row 5) ----
const txRows = sheetRows('Transactions').slice(4);
const insTx = db.prepare(
  `INSERT INTO transactions (date, description, account, category, amount, currency, fx_rate, amount_czk, type, entity, notes, recurring)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
);
const insFx = db.prepare('INSERT OR IGNORE INTO fx_rates (date, base, quote, rate) VALUES (?,?,?,?)');
let nTx = 0;
const seedAll = db.transaction(() => {
  for (const r of txRows) {
    const date = toDateStr(r?.[0]);
    if (!date || r[4] == null) continue;
    const amount = Number(r[4]);
    const currency = String(r[5] ?? 'CZK').trim().toUpperCase();
    const fxRate = r[6] != null && r[6] !== '' ? Number(r[6]) : null;
    const amountCzk = r[7] != null && r[7] !== '' ? Number(r[7]) : fxRate != null ? amount * fxRate : null;
    insTx.run(
      date,
      String(r[1] ?? '').trim(),
      String(r[2] ?? '').trim(),
      r[3] ? String(r[3]).trim() : null,
      amount,
      currency,
      fxRate,
      amountCzk,
      String(r[8] ?? 'Expense').trim(),
      r[9] ? String(r[9]).trim() : null,
      r[10] ? String(r[10]) : null,
      String(r[11] ?? '').toLowerCase() === 'yes' ? 1 : 0
    );
    // Warm the FX cache from historical rates already in the sheet
    if (fxRate != null && currency !== 'CZK') insFx.run(date, currency, 'CZK', fxRate);
    nTx++;
  }
});
seedAll();

// ---- Burn Rate: income sources (rows 5-8) and budget groups (rows 13-20) ----
const burn = sheetRows('Burn Rate');
const insInc = db.prepare('INSERT INTO income_sources (name, amount, currency, rate_to_czk, monthly_czk, notes) VALUES (?,?,?,?,?,?)');
let nInc = 0;
for (const r of burn.slice(4, 8)) {
  if (!r?.[0]) continue;
  insInc.run(String(r[0]).trim(), r[1] != null ? Number(r[1]) : null, r[2] ?? 'CZK', r[3] != null ? Number(r[3]) : null, r[4] != null ? Number(r[4]) : 0, r[5] ?? null);
  nInc++;
}
const insBud = db.prepare('INSERT OR REPLACE INTO budgets (grp, monthly_czk) VALUES (?,?)');
let nBud = 0;
for (const r of burn.slice(12, 20)) {
  if (!r?.[0] || String(r[0]).startsWith('TOTAL')) continue;
  insBud.run(String(r[0]).trim(), r[1] != null ? Number(r[1]) : 0);
  nBud++;
}

console.log(`Seeded: ${nTx} transactions, ${nAcc} accounts, ${nCat} categories, ${nBud} budget groups, ${nInc} income sources.`);
