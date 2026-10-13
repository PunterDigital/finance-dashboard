import express from 'express';
import path from 'node:path';
import type { Server } from 'node:http';
import { db } from './db.js';
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

const asyncH =
  (fn: (req: express.Request, res: express.Response) => Promise<void> | void) =>
  async (req: express.Request, res: express.Response) => {
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
  const { month, account, category, type, entity, search, limit = '200', offset = '0' } = req.query as Record<string, string>;
  const where: string[] = [];
  const params: any[] = [];
  if (month) { where.push('substr(date,1,7)=?'); params.push(month); }
  if (account) { where.push('account=?'); params.push(account); }
  if (category) { where.push('category=?'); params.push(category); }
  if (type) { where.push('type=?'); params.push(type); }
  if (entity) { where.push('entity=?'); params.push(entity); }
  if (search) { where.push('(description LIKE ? OR notes LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
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
  res.json(db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id));
}));

app.delete('/api/transactions/:id', (req, res) => {
  unlinkTransfer(Number(req.params.id));
  db.prepare('DELETE FROM transactions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
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
