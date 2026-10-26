import express from 'express';
import path from 'node:path';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { db } from './db.js';
import { backupDatabase, resetDatabase } from './maintenance.js';
import { getRate, getRateWithFallback, latestKnownRate } from './fx.js';
import { detectRecurring } from './recurring.js';
import { autoMatchTransfers, listTransfers, linkTransfers, unlinkTransfer, flipTransfer, setTransferRole, resetTransfers } from './transfers.js';
import { listMonths, monthlySummary, spendPerCategory, burnRate, overview, accountBalances } from './reports.js';

export const app = express();
app.disable('x-powered-by');

// The API has no auth: it is only ever reachable on loopback. Rejecting foreign Host headers also
// stops a web page from reading it through DNS rebinding.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
app.use((req, res, next) => {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    res.status(403).json({ error: 'Forbidden host' });
    return;
  }
  next();
});
app.use(express.json({ limit: '20mb' }));
// Express 5 leaves req.body undefined when a request has no JSON body; the handlers expect {} as in v4.
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});

const asyncH =
  (fn: (req: express.Request<Record<string, string>>, res: express.Response) => Promise<void> | void) =>
  async (req: express.Request<Record<string, string>>, res: express.Response) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err?.message ?? 'Internal error' });
    }
  };

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

async function computeCzk(row: { date: string; amount: number; currency: string; fx_rate?: number | null }) {
  let rate = row.fx_rate ?? null;
  if (rate == null) rate = await getRateWithFallback(row.currency, 'CZK', row.date);
  return { rate, amountCzk: rate != null ? row.amount * rate : null };
}

// ---------- transactions ----------
app.get('/api/transactions', (req, res) => {
  const { month, account, category, type, entity, search, necessity, limit = '200', offset = '0' } = req.query as Record<string, string>;
  const where: string[] = [];
  const params: any[] = [];
  if (month) { where.push('substr(date,1,7)=?'); params.push(month); }
  if (account) { where.push('account=?'); params.push(account); }
  if (category) { where.push('category=?'); params.push(category); }
  if (type) { where.push('type=?'); params.push(type); }
  if (entity) { where.push('entity=?'); params.push(entity); }
  if (search) { where.push('(description LIKE ? OR notes LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (necessity === 'need' || necessity === 'want') { where.push('necessity=?'); params.push(necessity); }
  if (necessity === 'unsorted') where.push("necessity IS NULL AND type='Expense'");
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM transactions ${w}`).get(...params) as any).n;
  const sums = db.prepare(
    `SELECT SUM(CASE WHEN type='Income' THEN abs(amount_czk) ELSE 0 END) AS income,
            SUM(CASE WHEN type='Expense' THEN abs(amount_czk) ELSE 0 END) AS expenses
     FROM transactions ${w}`).get(...params) as any;
  const rows = db
    .prepare(`SELECT * FROM transactions ${w} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(limit), Number(offset));
  res.json({ total, income: sums.income ?? 0, expenses: sums.expenses ?? 0, rows });
});

app.post('/api/transactions', asyncH(async (req, res) => {
  const t = req.body;
  const { rate, amountCzk } = await computeCzk(t);
  const info = db
    .prepare(
      `INSERT INTO transactions (date, description, account, category, amount, currency, fx_rate, amount_czk, type, entity, notes, recurring)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(t.date, t.description ?? '', t.account, t.category ?? null, t.amount, t.currency ?? 'CZK', rate, amountCzk, t.type ?? 'Expense', t.entity ?? null, t.notes ?? null, t.recurring ? 1 : 0);
  res.json(db.prepare('SELECT * FROM transactions WHERE id=?').get(info.lastInsertRowid));
}));

app.put('/api/transactions/:id', asyncH(async (req, res) => {
  const t = req.body;
  // A row edited away from Transfer can't stay linked to a counterpart
  if (t.type !== 'Transfer') unlinkTransfer(Number(req.params.id));
  const { rate, amountCzk } = await computeCzk(t);
  db.prepare(
    `UPDATE transactions SET date=?, description=?, account=?, category=?, amount=?, currency=?, fx_rate=?, amount_czk=?, type=?, entity=?, notes=?, recurring=? WHERE id=?`
  ).run(t.date, t.description ?? '', t.account, t.category ?? null, t.amount, t.currency ?? 'CZK', rate, amountCzk, t.type ?? 'Expense', t.entity ?? null, t.notes ?? null, t.recurring ? 1 : 0, req.params.id);
  if ((t.type ?? 'Expense') !== 'Expense') db.prepare('UPDATE transactions SET necessity=NULL, necessity_skipped=0 WHERE id=?').run(req.params.id);
  // A category given in the editor settles a row skipped on the category picker.
  if (typeof t.category === 'string' && t.category.trim()) db.prepare('UPDATE transactions SET category_skipped=0 WHERE id=?').run(req.params.id);
  res.json(db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id));
}));

app.delete('/api/transactions/:id', (req, res) => {
  unlinkTransfer(Number(req.params.id));
  db.prepare('DELETE FROM transactions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- need / want (#2818) ----------
// Sets or clears (null) the need/want choice on one expense.
app.put('/api/transactions/:id/necessity', (req, res) => {
  const value = req.body.necessity ?? null;
  if (value !== null && value !== 'need' && value !== 'want') {
    res.status(400).json({ error: 'necessity must be "need", "want" or null' });
    return;
  }
  const tx = db.prepare('SELECT type FROM transactions WHERE id=?').get(req.params.id) as { type: string } | undefined;
  if (!tx) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }
  if (tx.type !== 'Expense' && value !== null) {
    res.status(400).json({ error: 'Only expenses can be marked need or want' });
    return;
  }
  // Choosing (or undoing a choice) settles the row, so it is no longer "skipped" (#3344).
  db.prepare('UPDATE transactions SET necessity=?, necessity_skipped=0 WHERE id=?').run(value, req.params.id);
  res.json(db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id));
});

// Validates the `{ skipped: boolean }` body of the skip endpoints; sends a 400 and returns null if bad.
function skipFlag(req: express.Request, res: express.Response): 0 | 1 | null {
  if (typeof req.body.skipped !== 'boolean') {
    res.status(400).json({ error: 'skipped must be true or false' });
    return null;
  }
  return req.body.skipped ? 1 : 0;
}

// Skips (or un-skips) an expense on the sorter. Saved, so it stays skipped after a restart (#3344).
app.put('/api/transactions/:id/necessity-skip', (req, res) => {
  const flag = skipFlag(req, res);
  if (flag === null) return;
  const tx = db.prepare('SELECT type FROM transactions WHERE id=?').get(req.params.id) as { type: string } | undefined;
  if (!tx) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }
  if (tx.type !== 'Expense' && flag) {
    res.status(400).json({ error: 'Only expenses can be skipped on the need/want sorter' });
    return;
  }
  db.prepare('UPDATE transactions SET necessity_skipped=? WHERE id=?').run(flag, req.params.id);
  res.json(db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id));
});

// "Review skipped": every skipped expense goes back into the queue.
app.post('/api/necessity/skips/clear', (_req, res) => {
  const info = db.prepare('UPDATE transactions SET necessity_skipped=0 WHERE necessity_skipped != 0').run();
  res.json({ cleared: Number(info.changes) });
});

const UNSORTED = "type='Expense' AND necessity IS NULL";

// Unsorted expenses that aren't skipped, newest first. `total` counts every unsorted expense and
// `skipped` the ones left out because they were skipped, so `total - skipped` is what's left to sort.
app.get('/api/necessity/queue', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const { total, skipped } = db
    .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(necessity_skipped != 0), 0) AS skipped FROM transactions WHERE ${UNSORTED}`)
    .get() as { total: number; skipped: number };
  const rows = db
    .prepare(`SELECT * FROM transactions WHERE ${UNSORTED} AND necessity_skipped = 0 ORDER BY date DESC, id DESC LIMIT ?`)
    .all(limit);
  res.json({ total, skipped, rows });
});

// ---------- assign categories (#2892) ----------
// Income and expenses without a category. Transfers don't use categories, so they never queue.
const UNCATEGORISED = "type != 'Transfer' AND (category IS NULL OR trim(category) = '')";

// Sets or clears (null) the category on one income or expense row. The category must exist and
// be of the row's type, the same choice the Transactions editor offers.
app.put('/api/transactions/:id/category', (req, res) => {
  const value: unknown = req.body.category ?? null;
  if (value !== null && typeof value !== 'string') {
    res.status(400).json({ error: 'category must be a string or null' });
    return;
  }
  const tx = db.prepare('SELECT type FROM transactions WHERE id=?').get(req.params.id) as { type: string } | undefined;
  if (!tx) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }
  if (value !== null) {
    if (tx.type === 'Transfer') {
      res.status(400).json({ error: 'Transfers have no category' });
      return;
    }
    const cat = db.prepare('SELECT type FROM categories WHERE name=?').get(value) as { type: string } | undefined;
    if (!cat) {
      res.status(400).json({ error: `No category called "${value}"` });
      return;
    }
    if (cat.type !== tx.type) {
      res.status(400).json({ error: `"${value}" is a ${cat.type.toLowerCase()} category` });
      return;
    }
  }
  // Assigning (or undoing) settles the row, so it is no longer "skipped" (#3344).
  db.prepare('UPDATE transactions SET category=?, category_skipped=0 WHERE id=?').run(value, req.params.id);
  res.json(db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id));
});

// Skips (or un-skips) a row on the category picker. Saved, so it stays skipped after a restart (#3344).
app.put('/api/transactions/:id/category-skip', (req, res) => {
  const flag = skipFlag(req, res);
  if (flag === null) return;
  const tx = db.prepare('SELECT type FROM transactions WHERE id=?').get(req.params.id) as { type: string } | undefined;
  if (!tx) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }
  if (tx.type === 'Transfer' && flag) {
    res.status(400).json({ error: 'Transfers have no category' });
    return;
  }
  db.prepare('UPDATE transactions SET category_skipped=? WHERE id=?').run(flag, req.params.id);
  res.json(db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id));
});

// "Review skipped": every skipped row goes back into the category queue.
app.post('/api/category/skips/clear', (_req, res) => {
  const info = db.prepare('UPDATE transactions SET category_skipped=0 WHERE category_skipped != 0').run();
  res.json({ cleared: Number(info.changes) });
});

// Uncategorised rows that aren't skipped, newest first, each with `suggestion`: the category most
// often given to other rows of the same type and description (null if none). `total` counts every
// uncategorised row and `skipped` the ones left out because they were skipped.
app.get('/api/category/queue', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const { total, skipped } = db
    .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(category_skipped != 0), 0) AS skipped FROM transactions WHERE ${UNCATEGORISED}`)
    .get() as { total: number; skipped: number };
  const rows = db
    .prepare(`SELECT * FROM transactions WHERE ${UNCATEGORISED} AND category_skipped = 0 ORDER BY date DESC, id DESC LIMIT ?`)
    .all(limit) as { description: string; type: string }[];
  // Matched in JS, not SQL: SQLite's lower() only folds ASCII, and descriptions are often Czech.
  const key = (type: string, description: string) => `${type}\u0000${description.trim().toLocaleLowerCase('cs')}`;
  const best = new Map<string, { category: string; n: number; last: string }>();
  const used = db
    .prepare(
      `SELECT t.type, t.description, t.category, COUNT(*) AS n, MAX(t.date) AS last
         FROM transactions t JOIN categories c ON c.name = t.category AND c.type = t.type
        WHERE trim(t.description) != '' GROUP BY t.type, t.description, t.category`
    )
    .all() as { type: string; description: string; category: string; n: number; last: string }[];
  const tally = new Map<string, Map<string, { n: number; last: string }>>();
  for (const u of used) {
    const k = key(u.type, u.description);
    const cats = tally.get(k) ?? new Map();
    const c = cats.get(u.category) ?? { n: 0, last: '' };
    cats.set(u.category, { n: c.n + u.n, last: u.last > c.last ? u.last : c.last });
    tally.set(k, cats);
  }
  for (const [k, cats] of tally) {
    for (const [category, c] of cats) {
      const b = best.get(k);
      if (!b || c.n > b.n || (c.n === b.n && c.last > b.last)) best.set(k, { category, ...c });
    }
  }
  res.json({
    total,
    skipped,
    rows: rows.map((r) => ({ ...r, suggestion: best.get(key(r.type, r.description))?.category ?? null })),
  });
});

app.get('/api/months', (_req, res) => res.json(listMonths()));

// ---------- accounts / categories ----------
app.get('/api/accounts', (_req, res) => res.json(db.prepare('SELECT * FROM accounts ORDER BY type, name').all()));
app.post('/api/accounts', (req, res) => {
  const a = req.body;
  const info = db
    .prepare('INSERT INTO accounts (name, type, entity, base_currency, opening_balance) VALUES (?,?,?,?,?)')
    .run(a.name, a.type ?? 'Personal', a.entity ?? null, a.base_currency ?? 'CZK', a.opening_balance ?? 0);
  res.json(db.prepare('SELECT * FROM accounts WHERE id=?').get(info.lastInsertRowid));
});
app.put('/api/accounts/:id', (req, res) => {
  const a = req.body;
  const old = db.prepare('SELECT name FROM accounts WHERE id=?').get(req.params.id) as any;
  db.prepare('UPDATE accounts SET name=?, type=?, entity=?, base_currency=?, opening_balance=? WHERE id=?')
    .run(a.name, a.type, a.entity ?? null, a.base_currency, a.opening_balance ?? 0, req.params.id);
  if (old && old.name !== a.name) db.prepare('UPDATE transactions SET account=? WHERE account=?').run(a.name, old.name);
  res.json({ ok: true });
});
app.delete('/api/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/categories', (_req, res) => res.json(db.prepare('SELECT * FROM categories ORDER BY type, grp, name').all()));
app.post('/api/categories', (req, res) => {
  const c = req.body;
  const info = db.prepare('INSERT INTO categories (name, type, grp) VALUES (?,?,?)').run(c.name, c.type ?? 'Expense', c.grp ?? 'Other');
  res.json(db.prepare('SELECT * FROM categories WHERE id=?').get(info.lastInsertRowid));
});
app.put('/api/categories/:id', (req, res) => {
  const c = req.body;
  const old = db.prepare('SELECT name FROM categories WHERE id=?').get(req.params.id) as any;
  db.prepare('UPDATE categories SET name=?, type=?, grp=? WHERE id=?').run(c.name, c.type, c.grp ?? 'Other', req.params.id);
  if (old && old.name !== c.name) db.prepare('UPDATE transactions SET category=? WHERE category=?').run(c.name, old.name);
  res.json({ ok: true });
});
app.delete('/api/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- reports ----------
app.get('/api/reports/overview', (req, res) => res.json(overview((req.query.month as string) || currentMonth())));
app.get('/api/reports/monthly', (_req, res) => res.json(monthlySummary()));
app.get('/api/reports/categories', (req, res) => {
  const month = (req.query.month as string) || null;
  res.json(spendPerCategory(month === 'all' ? null : month || currentMonth()));
});
app.get('/api/reports/burnrate', (req, res) => res.json(burnRate((req.query.month as string) || currentMonth())));
app.get('/api/reports/balances', (_req, res) => res.json(accountBalances()));

// ---------- budgets / income sources ----------
app.get('/api/budgets', (_req, res) => res.json(db.prepare('SELECT grp, monthly_czk FROM budgets ORDER BY rowid').all()));
app.put('/api/budgets', (req, res) => {
  const rows = req.body as { grp: string; monthly_czk: number }[];
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM budgets').run();
    const ins = db.prepare('INSERT INTO budgets (grp, monthly_czk) VALUES (?,?)');
    for (const r of rows) if (r.grp?.trim()) ins.run(r.grp.trim(), r.monthly_czk || 0);
  });
  replace();
  res.json({ ok: true });
});

app.get('/api/income-sources', (_req, res) => res.json(db.prepare('SELECT * FROM income_sources ORDER BY id').all()));
app.put('/api/income-sources', asyncH(async (req, res) => {
  const rows = req.body as any[];
  for (const r of rows) {
    if (r.amount && !r.rate_to_czk) {
      r.rate_to_czk = (await getRateWithFallback(r.currency ?? 'CZK', 'CZK', new Date().toISOString().slice(0, 10))) ?? 1;
    }
    r.monthly_czk = r.amount ? r.amount * (r.rate_to_czk ?? 1) : 0;
  }
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM income_sources').run();
    const ins = db.prepare('INSERT INTO income_sources (name, amount, currency, rate_to_czk, monthly_czk, notes) VALUES (?,?,?,?,?,?)');
    for (const r of rows) if (r.name?.trim()) ins.run(r.name.trim(), r.amount ?? null, r.currency ?? 'CZK', r.rate_to_czk ?? null, r.monthly_czk ?? 0, r.notes ?? null);
  });
  replace();
  res.json(db.prepare('SELECT * FROM income_sources ORDER BY id').all());
}));

// ---------- recurring ----------
app.get('/api/recurring', (_req, res) => res.json(db.prepare('SELECT * FROM recurring ORDER BY next_expected').all()));
app.post('/api/recurring/detect', (_req, res) => res.json(detectRecurring()));
app.put('/api/recurring/:id', (req, res) => {
  const r = req.body;
  db.prepare('UPDATE recurring SET description=?, amount=?, currency=?, account=?, category=?, frequency=?, last_seen=?, next_expected=?, active=? WHERE id=?')
    .run(r.description, r.amount ?? null, r.currency ?? null, r.account ?? null, r.category ?? null, r.frequency ?? null, r.last_seen ?? null, r.next_expected ?? null, r.active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/recurring/:id', (req, res) => {
  db.prepare('DELETE FROM recurring WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- transfers ----------
app.get('/api/transfers', (_req, res) => res.json(listTransfers()));
app.post('/api/transfers/match', (_req, res) => res.json(autoMatchTransfers()));
app.post('/api/transfers/reset', (_req, res) => { resetTransfers(); res.json({ ok: true }); });
app.put('/api/transfers/link', (req, res) => { linkTransfers(req.body.outId, req.body.inId); res.json({ ok: true }); });
app.put('/api/transfers/unlink', (req, res) => { unlinkTransfer(req.body.id); res.json({ ok: true }); });
app.put('/api/transfers/flip', (req, res) => { flipTransfer(req.body.id); res.json({ ok: true }); });
app.put('/api/transfers/role', (req, res) => { setTransferRole(req.body.id, req.body.role ?? null); res.json({ ok: true }); });

// ---------- FX ----------
app.get('/api/fx', asyncH(async (req, res) => {
  const { from, to = 'CZK', date } = req.query as Record<string, string>;
  const rate = await getRate(from, to, date || new Date().toISOString().slice(0, 10));
  if (rate == null) {
    const fallback = latestKnownRate(from, to);
    res.json({ rate: fallback, source: fallback != null ? 'fallback-latest-known' : 'unavailable' });
    return;
  }
  res.json({ rate, source: 'frankfurter' });
}));

// Fill missing amount_czk on existing transactions
app.post('/api/fx/backfill', asyncH(async (_req, res) => {
  const missing = db.prepare('SELECT id, date, amount, currency FROM transactions WHERE fx_rate IS NULL OR amount_czk IS NULL').all() as any[];
  let updated = 0, failed = 0;
  for (const t of missing) {
    const rate = await getRateWithFallback(t.currency, 'CZK', t.date);
    if (rate != null) {
      db.prepare('UPDATE transactions SET fx_rate=?, amount_czk=? WHERE id=?').run(rate, t.amount * rate, t.id);
      updated++;
    } else failed++;
  }
  res.json({ updated, failed, remaining: failed });
}));

// ---------- import templates ----------
app.get('/api/import-templates', (_req, res) => {
  const rows = db.prepare('SELECT * FROM import_templates ORDER BY name').all() as any[];
  res.json(rows.map((r) => ({ ...r, config: JSON.parse(r.config) })));
});
app.post('/api/import-templates', (req, res) => {
  const { name, config } = req.body;
  db.prepare('INSERT INTO import_templates (name, config) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET config=excluded.config')
    .run(name, JSON.stringify(config));
  res.json({ ok: true });
});
app.delete('/api/import-templates/:id', (req, res) => {
  db.prepare('DELETE FROM import_templates WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- CSV import ----------
// rows: normalized transactions from the client-side wizard
app.post('/api/import/check', (req, res) => {
  const rows = req.body.rows as any[];
  const dupStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE date=? AND account=? AND abs(amount - ?) < 0.005 AND lower(trim(description)) = lower(trim(?))`
  );
  const seen = new Set<string>();
  const result = rows.map((r) => {
    const key = `${r.date}|${r.account}|${r.amount}|${(r.description ?? '').toLowerCase().trim()}`;
    const inDb = (dupStmt.get(r.date, r.account, r.amount, r.description ?? '') as any).n > 0;
    const inBatch = seen.has(key);
    seen.add(key);
    return { duplicate: inDb, duplicateInBatch: inBatch };
  });
  res.json(result);
});

app.post('/api/import', asyncH(async (req, res) => {
  const rows = req.body.rows as any[];
  let inserted = 0, fxMissing = 0;
  const prepared: any[] = [];
  for (const r of rows) {
    const { rate, amountCzk } = await computeCzk(r);
    if (rate == null) fxMissing++;
    prepared.push({ ...r, fx_rate: rate, amount_czk: amountCzk });
  }
  const ins = db.prepare(
    `INSERT INTO transactions (date, description, account, category, amount, currency, fx_rate, amount_czk, type, entity, notes, recurring)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`
  );
  const commit = db.transaction(() => {
    for (const r of prepared) {
      ins.run(r.date, r.description ?? '', r.account, r.category ?? null, r.amount, r.currency ?? 'CZK', r.fx_rate, r.amount_czk, r.type ?? 'Expense', r.entity ?? null, r.notes ?? null);
      inserted++;
    }
  });
  commit();
  res.json({ inserted, fxMissing });
}));

// ---------- database maintenance ----------
// A consistent copy of the live database, as a file download. It is read into memory and the temp
// copy deleted before sending: Windows can't delete a file that a response stream still has open.
app.get('/api/maintenance/backup', (_req, res) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-backup-'));
  let data: Buffer;
  try {
    const file = path.join(dir, 'finance.db');
    backupDatabase(file);
    data = fs.readFileSync(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  res.attachment(`finance-backup-${new Date().toISOString().slice(0, 10)}.db`);
  res.type('application/vnd.sqlite3').send(data);
});

// Needs a JSON body (so a cross-site form can't send it) and a same-origin Origin, if there is one.
app.post('/api/maintenance/reset', (req, res) => {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) {
    res.status(403).json({ error: 'Forbidden origin' });
    return;
  }
  if (req.body?.confirm !== 'RESET') {
    res.status(400).json({ error: 'Type RESET to confirm' });
    return;
  }
  res.json({ backup: resetDatabase() });
});

// Serves the built UI (desktop app). Call after all /api routes are registered.
export function serveStatic(dir: string) {
  app.use(express.static(dir));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dir, 'index.html')));
}

export function listen(port: number, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}
