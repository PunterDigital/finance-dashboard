import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { czk, pct, monthLabel, currentMonth } from '../format';
import { useChartTheme } from '../theme';
import { CURRENCIES } from '../types';
import { MonthPicker, StatTile, Toast, useToast } from '../components/ui';

export default function BurnRate() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<any | null>(null);
  const [budgets, setBudgets] = useState<{ grp: string; monthly_czk: number }[]>([]);
  const [incomes, setIncomes] = useState<any[]>([]);
  const [dirty, setDirty] = useState(false);
  const [toast, showToast] = useToast();
  const theme = useChartTheme();

  useEffect(() => {
    api.get<string[]>('/api/months').then((ms) => {
      if (ms.length && !ms.includes(currentMonth())) setMonth(ms[0]);
    }).catch(() => {});
  }, []);

  const load = useCallback((cancelled?: () => boolean) => {
    api.get(`/api/reports/burnrate?month=${month}`).then((d) => {
      if (cancelled?.()) return;
      setData(d);
      setBudgets(d.groups.map((g: any) => ({ grp: g.grp, monthly_czk: g.projected })));
      setIncomes(d.incomeSources);
      setDirty(false);
    });
  }, [month]);
  useEffect(() => {
    let stale = false;
    load(() => stale);
    return () => { stale = true; };
  }, [load]);

  if (!data) return <div className="empty">Loading…</div>;
  const s = data.summary;

  const saveBudgets = async () => {
    await api.put('/api/budgets', budgets);
    await api.put('/api/income-sources', incomes);
    showToast('Budget & income saved');
    load();
  };

  const setBudget = (grp: string, v: number) => {
    setBudgets(budgets.map((b) => (b.grp === grp ? { ...b, monthly_czk: v } : b)));
    setDirty(true);
  };
  const setIncome = (i: number, patch: any) => {
    setIncomes(incomes.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const totalProjected = budgets.reduce((sum, b) => sum + (b.monthly_czk || 0), 0);
  const totalActual = data.groups.reduce((sum: number, g: any) => sum + g.actual, 0);
  const maxBar = Math.max(...data.groups.map((g: any) => Math.max(g.actual, g.projected)), 1);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Burn Rate &amp; Budget</h2>
          <div className="sub">Projected vs actual for {monthLabel(month)}</div>
        </div>
        <div className="head-controls">
          {dirty && <button className="primary" onClick={saveBudgets}>Save changes</button>}
          <MonthPicker value={month} onChange={setMonth} />
        </div>
      </div>

      <div className="grid cols-4">
        <StatTile label="Projected income / month" value={czk(s.projectedIncome)} />
        <StatTile label={`Actual expenses · ${monthLabel(month)}`} value={czk(s.actualExpenses)} />
        <StatTile label="Actual net" value={czk(s.actualNet)} />
        <StatTile label="Burn rate (spend ÷ projected income)" value={s.burnRatePct != null ? pct(s.burnRatePct) : '—'} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Runway</h3>
          <div className="stat-tile">
            <div className="value">{s.runwayMonths != null ? `${s.runwayMonths.toFixed(1)} months` : '—'}</div>
            <div className="delta">
              Cash {czk(s.totalCash)} ÷ avg monthly spend {czk(s.avgMonthlySpend)} (last 3 months) — if all income stopped today.
            </div>
          </div>
        </div>
        <div className="card">
          <h3>Monthly income sources <span className="muted small">(projected)</span></h3>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead><tr><th>Source</th><th className="num">Amount</th><th>Ccy</th><th className="num">≈ CZK / month</th></tr></thead>
              <tbody>
                {incomes.map((inc, i) => (
                  <tr key={i}>
                    <td><input style={{ width: '100%' }} value={inc.name} onChange={(e) => setIncome(i, { name: e.target.value })} /></td>
                    <td className="num"><input type="number" style={{ width: 90 }} value={inc.amount ?? ''} onChange={(e) => setIncome(i, { amount: e.target.value === '' ? null : +e.target.value, rate_to_czk: null })} /></td>
                    <td>
                      <select value={inc.currency} onChange={(e) => setIncome(i, { currency: e.target.value, rate_to_czk: null })}>
                        {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                      </select>
                    </td>
                    <td className="num">{czk(inc.monthly_czk)}</td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td>Total</td><td colSpan={2}></td>
                  <td className="num">{czk(incomes.reduce((sum, i) => sum + (i.monthly_czk || 0), 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="row mt8">
            <button className="small" onClick={() => { setIncomes([...incomes, { name: 'New source', amount: null, currency: 'CZK', monthly_czk: 0 }]); setDirty(true); }}>+ Add source</button>
            {incomes.length > 0 && <button className="small danger" onClick={() => { setIncomes(incomes.slice(0, -1)); setDirty(true); }}>Remove last</button>}
          </div>
          <div className="card-note">Leave the rate blank — the current daily rate is applied on save.</div>
        </div>
      </div>

      <div className="card">
        <h3>Budget vs actual by category group</h3>
        <div className="legend-row">
          <span className="key"><span className="swatch" style={{ background: theme.muted, opacity: 0.45 }} /> Projected (editable)</span>
          <span className="key"><span className="swatch" style={{ background: theme.expense }} /> Actual</span>
        </div>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr><th>Group</th><th className="num">Projected (CZK)</th><th className="num">Actual</th><th className="num">Difference</th><th style={{ width: '30%' }}></th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.groups.map((g: any) => {
                const budget = budgets.find((b) => b.grp === g.grp)?.monthly_czk ?? g.projected;
                const diff = budget - g.actual;
                const over = budget > 0 && g.actual > budget;
                return (
                  <tr key={g.grp}>
                    <td>{g.grp}</td>
                    <td className="num">
                      <input type="number" style={{ width: 110, textAlign: 'right' }} value={budget || ''}
                        placeholder="0" onChange={(e) => setBudget(g.grp, e.target.value === '' ? 0 : +e.target.value)} />
                    </td>
                    <td className="num">{czk(g.actual)}</td>
                    <td className={`num amount ${diff >= 0 ? 'pos' : 'neg'}`}>{czk(diff)}</td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <div style={{ height: 7, width: `${(budget / maxBar) * 100}%`, background: theme.muted, opacity: 0.45, borderRadius: '0 4px 4px 0' }} />
                        <div style={{ height: 7, width: `${(g.actual / maxBar) * 100}%`, background: theme.expense, borderRadius: '0 4px 4px 0' }} />
                      </div>
                    </td>
                    <td>
                      {budget === 0 && g.actual === 0 ? <span className="muted">—</span>
                        : budget === 0 ? <span className="badge neutral">No budget set</span>
                        : over ? <span className="badge expense">Over budget</span>
                        : <span className="badge income">Under budget</span>}
                    </td>
                  </tr>
                );
              })}
              <tr className="total-row">
                <td>Total</td>
                <td className="num">{czk(totalProjected)}</td>
                <td className="num">{czk(totalActual)}</td>
                <td className={`num amount ${totalProjected - totalActual >= 0 ? 'pos' : 'neg'}`}>{czk(totalProjected - totalActual)}</td>
                <td colSpan={2}></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>Per-account summary · {monthLabel(month)}</h3>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead><tr><th>Account</th><th className="num">Income</th><th className="num">Expenses</th><th className="num">Net</th></tr></thead>
            <tbody>
              {data.perAccount.map((a: any) => (
                <tr key={a.account}>
                  <td>{a.account}</td>
                  <td className="num">{czk(a.income)}</td>
                  <td className="num">{czk(a.expenses)}</td>
                  <td className={`num amount ${a.income - a.expenses >= 0 ? 'pos' : 'neg'}`}>{czk(a.income - a.expenses)}</td>
                </tr>
              ))}
              {data.perAccount.length === 0 && <tr><td colSpan={4} className="empty">No activity this month.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Toast msg={toast} />
    </>
  );
}
