import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import { api } from '../api';
import { czk, compactCzk, pct, monthLabel, dateLabel, currentMonth } from '../format';
import { useChartTheme } from '../theme';
import { MonthPicker, StatTile, TypeBadge, VizTooltip } from '../components/ui';

export default function Dashboard() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = useChartTheme();

  useEffect(() => {
    let stale = false;
    api.get(`/api/reports/overview?month=${month}`)
      .then((d) => { if (!stale) setData(d); })
      .catch((e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [month]);

  useEffect(() => {
    // Default to the latest month that actually has data
    api.get<string[]>('/api/months').then((ms) => {
      if (ms.length && !ms.includes(currentMonth())) setMonth(ms[0]);
    }).catch(() => {});
  }, []);

  if (error) return <div className="callout warn">Failed to load: {error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const k = data.kpis;
  const prev = data.previous;
  const trend = data.trend.map((t: any) => ({ ...t, label: monthLabel(t.month) }));
  const totalCash = data.balances.reduce((s: number, b: any) => s + b.balanceCzk, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Dashboard</h2>
          <div className="sub">All figures in CZK · transfers excluded from income &amp; spend</div>
        </div>
        <div className="head-controls">
          <MonthPicker value={month} onChange={setMonth} />
        </div>
      </div>

      <div className="grid cols-4">
        <StatTile label={`Income · ${monthLabel(month)}`} value={czk(k.income)} delta={prev ? k.income - prev.income : null} />
        <StatTile label={`Expenses · ${monthLabel(month)}`} value={czk(k.expenses)} delta={prev ? k.expenses - prev.expenses : null} upIsGood={false} />
        <StatTile label="Net" value={czk(k.net)} delta={prev ? k.net - prev.net : null} />
        <StatTile label="Savings rate" value={pct(k.savingsRate)} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Income vs expenses by month</h3>
          <div className="legend-row">
            <span className="key"><span className="swatch" style={{ background: theme.income }} /> Income</span>
            <span className="key"><span className="swatch" style={{ background: theme.expense }} /> Expenses</span>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer>
              <BarChart data={trend} barGap={2} maxBarSize={24}>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: theme.muted, fontSize: 12 }} axisLine={{ stroke: theme.grid }} tickLine={false} />
                <YAxis tickFormatter={(v) => compactCzk(v)} tick={{ fill: theme.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={70} />
                <Tooltip content={<VizTooltip />} cursor={{ fill: theme.grid, opacity: 0.4 }} />
                <Bar dataKey="income" name="Income" fill={theme.income} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="expenses" name="Expenses" fill={theme.expense} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <h3>Top spending categories · {monthLabel(month)}</h3>
          {data.topCategories.length === 0 && <div className="empty">No expenses this month</div>}
          {data.topCategories.map((c: any) => {
            const max = data.topCategories[0].total;
            return (
              <div className="hbar-row" key={c.category}>
                <div className="hbar-label" title={`${c.category} (${c.grp})`}>{c.category}</div>
                <div className="hbar-track">
                  <div className="hbar-fill" style={{ width: `${(c.total / max) * 100}%`, background: theme.accent }} />
                </div>
                <div className="hbar-val">{czk(c.total)}</div>
              </div>
            );
          })}
          <div className="card-note">
            <Link to="/categories">Full category breakdown →</Link>
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Account balances <span className="muted small">(total {czk(totalCash)})</span></h3>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr><th>Account</th><th className="num">In</th><th className="num">Out</th><th className="num">Transfers (net)</th><th className="num">Balance (CZK)</th></tr>
              </thead>
              <tbody>
                {data.balances.map((b: any) => (
                  <tr key={b.id}>
                    <td>
                      {b.name} <span className="muted small">{b.base_currency}</span>
                      {b.transfersUnresolved > 0 && (
                        <Link to="/transfers" title={`${b.transfersUnresolved} transfer rows need review`} className="badge warn" style={{ marginLeft: 6, textDecoration: 'none' }}>
                          {b.transfersUnresolved} to review
                        </Link>
                      )}
                    </td>
                    <td className="num muted">{czk(b.income)}</td>
                    <td className="num muted">{czk(b.expenses)}</td>
                    <td className="num muted">{czk(b.transfersIn - b.transfersOut)}</td>
                    <td className={`num amount ${b.balanceCzk >= 0 ? 'pos' : 'neg'}`}>{czk(b.balanceCzk)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-note">Balance = opening + income − expenses + transfers in − transfers out. Both sides of each transfer are matched on the <Link to="/transfers">Transfers</Link> page; unresolved rows are excluded until reviewed.</div>
        </div>

        <div className="card">
          <h3>Upcoming recurring</h3>
          {data.upcoming.length === 0 && <div className="empty">Nothing due in the next 35 days.<br /><Link to="/recurring">Run detection →</Link></div>}
          {data.upcoming.length > 0 && (
            <table className="tbl">
              <thead>
                <tr><th>Due</th><th>Description</th><th className="num">Amount</th></tr>
              </thead>
              <tbody>
                {data.upcoming.map((u: any) => (
                  <tr key={u.id}>
                    <td>
                      {dateLabel(u.next_expected)}{' '}
                      {u.overdue && <span className="badge warn">overdue</span>}
                    </td>
                    <td>{u.description}</td>
                    <td className="num">{u.amount != null ? `${u.amount} ${u.currency}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Recent transactions</h3>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr><th>Date</th><th>Description</th><th>Account</th><th>Category</th><th className="num">Amount</th><th className="num">CZK</th><th>Type</th></tr>
            </thead>
            <tbody>
              {data.recent.map((t: any) => (
                <tr key={t.id}>
                  <td className="mono">{dateLabel(t.date)}</td>
                  <td>{t.description}</td>
                  <td className="muted">{t.account}</td>
                  <td className="muted">{t.category ?? '—'}</td>
                  <td className="num">{t.amount} {t.currency}</td>
                  <td className="num">{czk(t.amount_czk)}</td>
                  <td><TypeBadge type={t.type} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-note"><Link to="/transactions">All transactions →</Link></div>
      </div>
    </>
  );
}
