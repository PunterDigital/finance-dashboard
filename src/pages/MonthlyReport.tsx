import { useEffect, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { api } from '../api';
import { czk, compactCzk, monthLabel, pct } from '../format';
import { useChartTheme } from '../theme';
import { MonthlyRow } from '../types';
import { VizTooltip } from '../components/ui';

export default function MonthlyReport() {
  const [rows, setRows] = useState<MonthlyRow[]>([]);
  const theme = useChartTheme();

  useEffect(() => {
    api.get<MonthlyRow[]>('/api/reports/monthly').then(setRows);
  }, []);

  const chart = rows.map((r) => ({ ...r, label: monthLabel(r.month) }));

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Monthly Report</h2>
          <div className="sub">Income, expenses and net per month (CZK) · transfers excluded</div>
        </div>
      </div>

      <div className="card">
        <h3>Income, expenses &amp; net</h3>
        <div className="legend-row">
          <span className="key"><span className="swatch" style={{ background: theme.income }} /> Income</span>
          <span className="key"><span className="swatch" style={{ background: theme.expense }} /> Expenses</span>
          <span className="key"><span className="swatch" style={{ background: theme.accent, height: 3, borderRadius: 2 }} /> Net</span>
        </div>
        <div className="chart-wrap" style={{ height: 320 }}>
          <ResponsiveContainer>
            <ComposedChart data={chart} barGap={2} maxBarSize={24}>
              <CartesianGrid stroke={theme.grid} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: theme.muted, fontSize: 12 }} axisLine={{ stroke: theme.grid }} tickLine={false} />
              <YAxis tickFormatter={(v) => compactCzk(v)} tick={{ fill: theme.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={70} />
              <Tooltip content={<VizTooltip />} cursor={{ fill: theme.grid, opacity: 0.4 }} />
              <Bar dataKey="income" name="Income" fill={theme.income} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="expenses" name="Expenses" fill={theme.expense} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              <Line dataKey="net" name="Net" stroke={theme.accent} strokeWidth={2} dot={{ r: 4, fill: theme.accent, stroke: theme.surface, strokeWidth: 2 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card">
        <h3>Summary table</h3>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Month</th><th className="num">Income</th><th className="num">Expenses</th><th className="num">Net</th>
                <th>Top expense category</th><th className="num">Avg daily spend</th><th className="num">Savings rate</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.month}>
                  <td>{monthLabel(r.month)}</td>
                  <td className="num">{czk(r.income)}</td>
                  <td className="num">{czk(r.expenses)}</td>
                  <td className={`num amount ${r.net >= 0 ? 'pos' : 'neg'}`}>{czk(r.net)}</td>
                  <td className="muted">{r.topCategory ? `${r.topCategory} (${czk(r.topCategoryAmount)})` : '—'}</td>
                  <td className="num">{czk(r.avgDailySpend)}</td>
                  <td className={`num amount ${r.savingsRate >= 0 ? 'pos' : 'neg'}`}>{pct(r.savingsRate)}</td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr className="total-row">
                  <td>Total</td>
                  <td className="num">{czk(rows.reduce((s, r) => s + r.income, 0))}</td>
                  <td className="num">{czk(rows.reduce((s, r) => s + r.expenses, 0))}</td>
                  <td className={`num amount ${rows.reduce((s, r) => s + r.net, 0) >= 0 ? 'pos' : 'neg'}`}>{czk(rows.reduce((s, r) => s + r.net, 0))}</td>
                  <td colSpan={3}></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
