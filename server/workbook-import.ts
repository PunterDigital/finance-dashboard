import xlsx from 'xlsx';
import { db } from './db.js';

// Import of the old Google Sheets workbook (financial_tracker.xlsx) into SQLite.
// `npm run seed` (server/seed.ts) is the command-line entry point.

export type ImportCounts = {
  transactions: number;
  accounts: number;
  categories: number;
  budgets: number;
  incomeSources: number;
};

function sheetRows(wb: xlsx.WorkBook, name: string): any[][] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as any[][];
}

// Excel serial / string / Date -> YYYY-MM-DD
export function toDateStr(v: any): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return isNaN(+d) ? null : d.toISOString().slice(0, 10);
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

// Number cell, or text like "1,234.50" / "CZK 250" / "-£12" -> number; empty or not a number -> null.
export function toAmount(v: any): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[\s,]/g, '').replace(/^([+-]?)[^\d.+-]+/, '$1');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return Number(s);
}

/** Wipes the imported tables and loads them from `wb`. */
export function importWorkbook(wb: xlsx.WorkBook): ImportCounts {
  const wipe = db.transaction(() => {
    for (const t of ['transactions', 'accounts', 'categories', 'budgets', 'income_sources', 'recurring']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
  });
  wipe();

  // ---- Accounts (header row 3, data from row 4) ----
  const accRows = sheetRows(wb, 'Accounts').slice(3);
  const insAcc = db.prepare('INSERT OR IGNORE INTO accounts (name, type, entity, base_currency, opening_balance) VALUES (?,?,?,?,?)');
  let nAcc = 0;
  for (const r of accRows) {
    if (!r?.[0]) continue;
    insAcc.run(String(r[0]).trim(), r[1] ?? 'Personal', r[2] ?? null, r[3] ?? 'CZK', toAmount(r[4]) ?? 0);
    nAcc++;
  }

  // ---- Categories (header row 3, data from row 4) ----
  const catRows = sheetRows(wb, 'Categories').slice(3);
  const insCat = db.prepare('INSERT OR IGNORE INTO categories (name, type, grp) VALUES (?,?,?)');
  let nCat = 0;
  for (const r of catRows) {
    if (!r?.[0]) continue;
    insCat.run(String(r[0]).trim(), r[1] ?? 'Expense', r[2] ?? 'Other');
    nCat++;
  }

  // ---- Transactions (header row 4, data from row 5) ----
  const txRows = sheetRows(wb, 'Transactions').slice(4);
  const insTx = db.prepare(
    `INSERT INTO transactions (date, description, account, category, amount, currency, fx_rate, amount_czk, type, entity, notes, recurring, category_source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insFx = db.prepare('INSERT OR IGNORE INTO fx_rates (date, base, quote, rate) VALUES (?,?,?,?)');
  let nTx = 0;
  const seedAll = db.transaction(() => {
    for (const r of txRows) {
      const date = toDateStr(r?.[0]);
      const amount = toAmount(r?.[4]);
      if (!date || amount == null) continue;
      const currency = String(r[5] ?? 'CZK').trim().toUpperCase();
      const fxRate = toAmount(r[6]);
      const amountCzk = toAmount(r[7]) ?? (fxRate != null ? amount * fxRate : null);
      const category = r[3] ? String(r[3]).trim() : null;
      insTx.run(
        date,
        String(r[1] ?? '').trim(),
        String(r[2] ?? '').trim(),
        category,
        amount,
        currency,
        fxRate,
        amountCzk,
        String(r[8] ?? 'Expense').trim(),
        r[9] ? String(r[9]).trim() : null,
        r[10] ? String(r[10]) : null,
        String(r[11] ?? '').toLowerCase() === 'yes' ? 1 : 0,
        category ? 'import' : null
      );
      // Warm the FX cache from historical rates already in the sheet
      if (fxRate != null && currency !== 'CZK') insFx.run(date, currency, 'CZK', fxRate);
      nTx++;
    }
  });
  seedAll();

  // ---- Burn Rate: income sources (rows 5-8) and budget groups (rows 13-20) ----
  const burn = sheetRows(wb, 'Burn Rate');
  const insInc = db.prepare('INSERT INTO income_sources (name, amount, currency, rate_to_czk, monthly_czk, notes) VALUES (?,?,?,?,?,?)');
  let nInc = 0;
  for (const r of burn.slice(4, 8)) {
    if (!r?.[0]) continue;
    insInc.run(String(r[0]).trim(), toAmount(r[1]), r[2] ?? 'CZK', toAmount(r[3]), toAmount(r[4]) ?? 0, r[5] ?? null);
    nInc++;
  }
  const insBud = db.prepare('INSERT OR REPLACE INTO budgets (grp, monthly_czk) VALUES (?,?)');
  let nBud = 0;
  for (const r of burn.slice(12, 20)) {
    if (!r?.[0] || String(r[0]).startsWith('TOTAL')) continue;
    insBud.run(String(r[0]).trim(), toAmount(r[1]) ?? 0);
    nBud++;
  }

  return { transactions: nTx, accounts: nAcc, categories: nCat, budgets: nBud, incomeSources: nInc };
}
