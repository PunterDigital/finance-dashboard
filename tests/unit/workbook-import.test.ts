import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import xlsx from 'xlsx';
import { describe, expect, it } from 'vitest';
import { db } from '../../server/db';
import { importWorkbook, toAmount, toDateStr } from '../../server/workbook-import';

// A made-up workbook laid out like the old Google Sheets tracker. Never the real one.
function fixtureWorkbook(): xlsx.WorkBook {
  const wb = xlsx.utils.book_new();
  const sheet = (name: string, rows: unknown[][]) =>
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), name);
  sheet('Accounts', [
    ['Accounts'], [], ['Name', 'Type', 'Entity', 'Currency', 'Opening'],
    ['Current', 'Personal', null, 'CZK', 10000],
    ['Business', 'Business', 'Acme s.r.o.', 'EUR', '1,500.50'],
    [null, 'Personal'],
  ]);
  sheet('Categories', [
    ['Categories'], [], ['Name', 'Type', 'Group'],
    ['Groceries', 'Expense', 'Living'],
    ['Salary', 'Income', 'Income'],
  ]);
  sheet('Transactions', [
    ['Transactions'], [], [],
    ['Date', 'Description', 'Account', 'Category', 'Amount', 'Currency', 'FX', 'CZK', 'Type', 'Entity', 'Notes', 'Recurring'],
    // Dates as Excel serials (what a Sheets export stores) and as ISO text.
    [45778, ' Tesco ', 'Current', 'Groceries', -850, 'czk', null, null, 'Expense', null, null, 'no'],
    ['2025-05-02', 'Invoice 7', 'Business', 'Salary', '2,000.00', 'EUR', 24.9, null, 'Income', 'Acme s.r.o.', 'paid late', 'Yes'],
    ['2025-05-03', 'Netflix', 'Current', null, -10, 'EUR', '25', -250, 'Expense', null, null, 'yes'],
    ['not a date', 'skipped', 'Current', null, -1],
    ['2025-05-04', 'no amount', 'Current', null, null],
    ['2025-05-05', 'bad amount', 'Current', null, 'n/a'],
  ]);
  const burn: unknown[][] = Array.from({ length: 20 }, () => []);
  burn[4] = ['Salary', 4000, 'EUR', 24.9, 99600, 'monthly'];
  burn[5] = ['Rent out', null, 'CZK', null, null];
  burn[12] = ['Living', 15000];
  burn[13] = ['Fun', '2 000'];
  burn[14] = ['TOTAL', 17000];
  sheet('Burn Rate', burn);
  // Round-trip through the .xlsx file format, as `npm run seed` reads one.
  return xlsx.read(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

describe('toDateStr', () => {
  it.each<[unknown, string | null]>([
    [45778, '2025-05-01'], [45778.75, '2025-05-01'], [1, '1899-12-31'],
    ['2025-05-02', '2025-05-02'], ['2025-05-02T23:30:00Z', '2025-05-02'], [' 2025-05-02 ', '2025-05-02'],
    ['May 2, 2025 12:00 UTC', '2025-05-02'], ['', null], [null, null], [undefined, null], ['soon', null],
  ])('%j -> %j', (input, want) => expect(toDateStr(input)).toBe(want));

  it('keeps the calendar day of a Date', () => {
    expect(toDateStr(new Date(2025, 4, 2, 23, 59))).toBe('2025-05-02');
  });
});

describe('toAmount', () => {
  it.each<[unknown, number | null]>([
    [12.5, 12.5], [-850, -850], [0, 0], ['2,000.00', 2000], ['-1 234.5', -1234.5], ['CZK 250', 250],
    ['-£12.34', -12.34], ['+99', 99], ['.5', 0.5], ['', null], [null, null], ['n/a', null], ['1.2.3', null],
    [Number.NaN, null], [Infinity, null],
  ])('%j -> %j', (input, want) => expect(toAmount(input)).toBe(want));
});

describe('importWorkbook', () => {
  it('imports accounts, categories, transactions, income sources and budgets', () => {
    const counts = importWorkbook(fixtureWorkbook());
    expect(counts).toEqual({ transactions: 3, accounts: 2, categories: 2, budgets: 2, incomeSources: 2 });

    expect(db.prepare('SELECT name, type, entity, base_currency, opening_balance FROM accounts ORDER BY name').all()).toEqual([
      { name: 'Business', type: 'Business', entity: 'Acme s.r.o.', base_currency: 'EUR', opening_balance: 1500.5 },
      { name: 'Current', type: 'Personal', entity: null, base_currency: 'CZK', opening_balance: 10000 },
    ]);

    const tx = db.prepare(
      'SELECT date, description, account, category, amount, currency, fx_rate, amount_czk, type, entity, notes, recurring FROM transactions ORDER BY date'
    ).all();
    expect(tx).toEqual([
      { date: '2025-05-01', description: 'Tesco', account: 'Current', category: 'Groceries', amount: -850, currency: 'CZK',
        fx_rate: null, amount_czk: null, type: 'Expense', entity: null, notes: null, recurring: 0 },
      { date: '2025-05-02', description: 'Invoice 7', account: 'Business', category: 'Salary', amount: 2000, currency: 'EUR',
        fx_rate: 24.9, amount_czk: 49800, type: 'Income', entity: 'Acme s.r.o.', notes: 'paid late', recurring: 1 },
      { date: '2025-05-03', description: 'Netflix', account: 'Current', category: null, amount: -10, currency: 'EUR',
        fx_rate: 25, amount_czk: -250, type: 'Expense', entity: null, notes: null, recurring: 1 },
    ]);
    expect(db.prepare("SELECT date, base, rate FROM fx_rates WHERE quote = 'CZK' ORDER BY date").all()).toEqual([
      { date: '2025-05-02', base: 'EUR', rate: 24.9 },
      { date: '2025-05-03', base: 'EUR', rate: 25 },
    ]);

    expect(db.prepare('SELECT name, amount, monthly_czk FROM income_sources ORDER BY name').all()).toEqual([
      { name: 'Rent out', amount: null, monthly_czk: 0 },
      { name: 'Salary', amount: 4000, monthly_czk: 99600 },
    ]);
    expect(db.prepare('SELECT grp, monthly_czk FROM budgets ORDER BY grp').all()).toEqual([
      { grp: 'Fun', monthly_czk: 2000 },
      { grp: 'Living', monthly_czk: 15000 },
    ]);
  });

  it('replaces the previous import instead of adding to it', () => {
    importWorkbook(fixtureWorkbook());
    expect(importWorkbook(fixtureWorkbook()).transactions).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(3);
  });
});

describe('npm run seed', () => {
  it('imports an .xlsx file into a fresh data dir, and only overwrites with --force', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-seed-'));
    const file = path.join(dir, 'fixture.xlsx');
    fs.writeFileSync(file, xlsx.write(fixtureWorkbook(), { type: 'buffer', bookType: 'xlsx' }));
    const seed = (...args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'server/seed.ts', file, ...args], {
        env: { ...process.env, FINANCE_DATA_DIR: path.join(dir, 'data') },
        encoding: 'utf8',
      });

    const first = seed();
    expect(first.stderr).toBe('');
    expect(first.stdout).toContain('Seeded: 3 transactions, 2 accounts, 2 categories, 2 budget groups, 2 income sources.');
    expect(seed().stdout).toContain('Database already has 3 transactions');
    expect(seed('--force').stdout).toContain('Seeded: 3 transactions');

    const dbFile = fs.readdirSync(path.join(dir, 'data')).find((f) => f.endsWith('.db'));
    const d = new DatabaseSync(path.join(dir, 'data', dbFile!), { readOnly: true });
    try {
      expect((d.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(3);
    } finally {
      d.close();
    }
  }, 30_000);
});
