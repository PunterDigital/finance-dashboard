import { db } from './db.js';
import { latestKnownRate } from './fx.js';

// All report figures are in CZK (amount_czk). Transfers are excluded from
// income/expense metrics, matching the Apps Script; they only affect balances.

function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function listMonths(): string[] {
  return (db.prepare(`SELECT DISTINCT substr(date,1,7) AS m FROM transactions ORDER BY m DESC`).all() as { m: string }[]).map((r) => r.m);
}

export function monthlySummary() {
  const rows = db
    .prepare(
      `SELECT substr(date,1,7) AS month,
              SUM(CASE WHEN type='Income' THEN abs(amount_czk) ELSE 0 END) AS income,
              SUM(CASE WHEN type='Expense' THEN abs(amount_czk) ELSE 0 END) AS expenses
       FROM transactions WHERE amount_czk IS NOT NULL
       GROUP BY month ORDER BY month`
    )
    .all() as { month: string; income: number; expenses: number }[];

  const topCats = db
    .prepare(
      `SELECT substr(date,1,7) AS month, COALESCE(category,'Uncategorized') AS category,
              SUM(abs(amount_czk)) AS total
       FROM transactions WHERE type='Expense' AND amount_czk IS NOT NULL
       GROUP BY month, category`
    )
    .all() as { month: string; category: string; total: number }[];
  const topByMonth = new Map<string, { category: string; total: number }>();
  for (const r of topCats) {
    const cur = topByMonth.get(r.month);
    if (!cur || r.total > cur.total) topByMonth.set(r.month, { category: r.category, total: r.total });
  }

  return rows.map((r) => {
    const net = r.income - r.expenses;
    const top = topByMonth.get(r.month);
    return {
      month: r.month,
      income: r.income,
      expenses: r.expenses,
      net,
      savingsRate: r.income > 0 ? net / r.income : 0,
      topCategory: top ? top.category : null,
      topCategoryAmount: top ? top.total : 0,
      avgDailySpend: r.expenses / daysInMonth(r.month),
    };
  });
}

export function spendPerCategory(month: string | null) {
  const where = month ? `AND substr(date,1,7) = ?` : '';
  const params = month ? [month] : [];
  const cats = db
    .prepare(
      `SELECT COALESCE(t.category,'Uncategorized') AS category,
              COALESCE(c.grp,'Other') AS grp,
              SUM(abs(t.amount_czk)) AS total,
              COUNT(*) AS count
       FROM transactions t
       LEFT JOIN categories c ON c.name = t.category
       WHERE t.type='Expense' AND t.amount_czk IS NOT NULL ${where}
       GROUP BY category ORDER BY total DESC`
    )
    .all(...params) as { category: string; grp: string; total: number; count: number }[];

  const monthTotal = cats.reduce((s, c) => s + c.total, 0);
  const days = month ? daysInMonth(month) : null;

  const txDetail = db
    .prepare(
      `SELECT id, date, description, account, amount, currency, abs(amount_czk) AS amount_czk,
              COALESCE(category,'Uncategorized') AS category
       FROM transactions t
       WHERE t.type='Expense' AND t.amount_czk IS NOT NULL ${where}
       ORDER BY amount_czk DESC`
    )
    .all(...params) as any[];
  const byCat = new Map<string, any[]>();
  for (const t of txDetail) {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category)!.push(t);
  }

  const groups = new Map<string, { total: number; categories: string[] }>();
  for (const c of cats) {
    if (!groups.has(c.grp)) groups.set(c.grp, { total: 0, categories: [] });
    const g = groups.get(c.grp)!;
    g.total += c.total;
    g.categories.push(c.category);
  }

  return {
    month,
    total: monthTotal,
    categories: cats.map((c) => ({
      ...c,
      avgPerTxn: c.total / c.count,
      pctOfTotal: monthTotal > 0 ? c.total / monthTotal : 0,
      avgPerDay: days ? c.total / days : null,
      transactions: byCat.get(c.category) ?? [],
    })),
    groups: [...groups.entries()]
      .map(([name, g]) => ({ name, total: g.total, categories: g.categories, pctOfTotal: monthTotal > 0 ? g.total / monthTotal : 0 }))
      .sort((a, b) => b.total - a.total),
  };
}

export function accountBalances() {
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY type, name').all() as any[];
  const flows = db
    .prepare(
      `SELECT account,
              SUM(CASE WHEN type='Income' THEN abs(amount_czk) ELSE 0 END) AS income,
              SUM(CASE WHEN type='Expense' THEN abs(amount_czk) ELSE 0 END) AS expenses,
              SUM(CASE WHEN type='Transfer' AND transfer_role='out' THEN abs(amount_czk) ELSE 0 END) AS transfers_out,
              SUM(CASE WHEN type='Transfer' AND transfer_role='in' THEN abs(amount_czk) ELSE 0 END) AS transfers_in,
              SUM(CASE WHEN type='Transfer' AND transfer_role IS NULL THEN 1 ELSE 0 END) AS transfers_unresolved
       FROM transactions WHERE amount_czk IS NOT NULL GROUP BY account`
    )
    .all() as any[];
  const byAccount = new Map(flows.map((f) => [f.account, f]));

  return accounts.map((a) => {
    const f = byAccount.get(a.name) ?? { income: 0, expenses: 0, transfers_out: 0, transfers_in: 0, transfers_unresolved: 0 };
    const rate = latestKnownRate(a.base_currency, 'CZK') ?? 1;
    const openingCzk = a.opening_balance * rate;
    return {
      ...a,
      income: f.income,
      expenses: f.expenses,
      transfersOut: f.transfers_out,
      transfersIn: f.transfers_in,
      transfersUnresolved: f.transfers_unresolved,
      openingCzk,
      // Paired transfers credit the destination with what actually arrived
      // (its own row's CZK value, so cross-currency fees are reflected).
      // Unresolved transfer rows are excluded until reviewed on /transfers.
      balanceCzk: openingCzk + f.income - f.expenses + f.transfers_in - f.transfers_out,
    };
  });
}

export function burnRate(month: string) {
  const budgets = db.prepare('SELECT grp, monthly_czk FROM budgets ORDER BY rowid').all() as { grp: string; monthly_czk: number }[];
  const actuals = db
    .prepare(
      `SELECT COALESCE(c.grp,'Other') AS grp, SUM(abs(t.amount_czk)) AS total
       FROM transactions t LEFT JOIN categories c ON c.name = t.category
       WHERE t.type='Expense' AND t.amount_czk IS NOT NULL AND substr(t.date,1,7)=?
       GROUP BY 1`
    )
    .all(month) as { grp: string; total: number }[];
  const actualByGrp = new Map(actuals.map((a) => [a.grp, a.total]));

  const grpNames = new Set(budgets.map((b) => b.grp));
  const rows = budgets.map((b) => ({
    grp: b.grp,
    projected: b.monthly_czk,
    actual: actualByGrp.get(b.grp) ?? 0,
  }));
  for (const a of actuals) {
    if (!grpNames.has(a.grp)) rows.push({ grp: a.grp, projected: 0, actual: a.total });
  }

  const incomeSources = db.prepare('SELECT * FROM income_sources ORDER BY id').all() as any[];
  const projectedIncome = incomeSources.reduce((s, i) => s + (i.monthly_czk ?? 0), 0);

  const actualTotals = db
    .prepare(
      `SELECT SUM(CASE WHEN type='Income' THEN abs(amount_czk) ELSE 0 END) AS income,
              SUM(CASE WHEN type='Expense' THEN abs(amount_czk) ELSE 0 END) AS expenses
       FROM transactions WHERE amount_czk IS NOT NULL AND substr(date,1,7)=?`
    )
    .get(month) as { income: number | null; expenses: number | null };

  const perAccount = db
    .prepare(
      `SELECT account,
              SUM(CASE WHEN type='Income' THEN abs(amount_czk) ELSE 0 END) AS income,
              SUM(CASE WHEN type='Expense' THEN abs(amount_czk) ELSE 0 END) AS expenses
       FROM transactions WHERE amount_czk IS NOT NULL AND substr(date,1,7)=?
       GROUP BY account ORDER BY account`
    )
    .all(month) as { account: string; income: number; expenses: number }[];

  const projectedExpenses = rows.reduce((s, r) => s + r.projected, 0);
  const actualExpenses = actualTotals.expenses ?? 0;
  const actualIncome = actualTotals.income ?? 0;

  // Runway: total cash now / average monthly spend over the last 3 full months
  const balances = accountBalances();
  const totalCash = balances.reduce((s, b) => s + b.balanceCzk, 0);
  const last3 = db
    .prepare(
      `SELECT substr(date,1,7) AS m, SUM(abs(amount_czk)) AS spend
       FROM transactions WHERE type='Expense' AND amount_czk IS NOT NULL AND substr(date,1,7) < ?
       GROUP BY m ORDER BY m DESC LIMIT 3`
    )
    .all(month) as { m: string; spend: number }[];
  const avgSpend = last3.length ? last3.reduce((s, r) => s + r.spend, 0) / last3.length : actualExpenses;

  return {
    month,
    groups: rows,
    incomeSources,
    summary: {
      projectedIncome,
      projectedExpenses,
      actualIncome,
      actualExpenses,
      projectedNet: projectedIncome - projectedExpenses,
      actualNet: actualIncome - actualExpenses,
      burnRatePct: projectedIncome > 0 ? actualExpenses / projectedIncome : null,
      totalCash,
      avgMonthlySpend: avgSpend,
      runwayMonths: avgSpend > 0 ? Math.max(0, totalCash / avgSpend) : null,
    },
    perAccount,
  };
}

export function overview(month: string) {
  const summary = monthlySummary();
  const current = summary.find((s) => s.month === month) ?? {
    month, income: 0, expenses: 0, net: 0, savingsRate: 0, topCategory: null, topCategoryAmount: 0, avgDailySpend: 0,
  };
  const idx = summary.findIndex((s) => s.month === month);
  const previous = idx > 0 ? summary[idx - 1] : null;

  const topCategories = db
    .prepare(
      `SELECT COALESCE(t.category,'Uncategorized') AS category, COALESCE(c.grp,'Other') AS grp, SUM(abs(t.amount_czk)) AS total
       FROM transactions t LEFT JOIN categories c ON c.name = t.category
       WHERE t.type='Expense' AND t.amount_czk IS NOT NULL AND substr(t.date,1,7)=?
       GROUP BY category ORDER BY total DESC LIMIT 8`
    )
    .all(month) as any[];

  const recent = db
    .prepare(`SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT 12`)
    .all() as any[];

  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 35 * 86400000).toISOString().slice(0, 10);
  const upcoming = db
    .prepare(
      `SELECT * FROM recurring WHERE active=1 AND next_expected IS NOT NULL AND next_expected <= ?
       ORDER BY next_expected LIMIT 10`
    )
    .all(horizon) as any[];

  return {
    month,
    kpis: current,
    previous,
    trend: summary,
    topCategories,
    balances: accountBalances(),
    recent,
    upcoming: upcoming.map((u) => ({ ...u, overdue: u.next_expected < today })),
  };
}
