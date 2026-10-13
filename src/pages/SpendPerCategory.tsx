import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { czk, dateLabel, num, pct, monthLabel, currentMonth } from '../format';
import { useChartTheme } from '../theme';
import { MonthPicker } from '../components/ui';

export default function SpendPerCategory() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<any | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const theme = useChartTheme();

  useEffect(() => {
    api.get<string[]>('/api/months').then((ms) => {
      if (ms.length && !ms.includes(currentMonth())) setMonth(ms[0]);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let stale = false;
    api.get(`/api/reports/categories?month=${month}`).then((d) => { if (!stale) setData(d); });
    setOpen(new Set());
    return () => { stale = true; };
  }, [month]);

  if (!data) return <div className="empty">Loading…</div>;

  const toggle = (cat: string) => {
    const next = new Set(open);
    next.has(cat) ? next.delete(cat) : next.add(cat);
    setOpen(next);
  };

  const maxCat = data.categories[0]?.total ?? 1;
  const title = month === 'all' ? 'All months' : monthLabel(month);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Spend per Category</h2>
          <div className="sub">{title} · total spend {czk(data.total)}</div>
        </div>
        <MonthPicker value={month} onChange={setMonth} allowAll />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>By group</h3>
          {data.groups.map((g: any) => (
            <div className="hbar-row" key={g.name}>
              <div className="hbar-label" title={g.categories.join(', ')}>{g.name}</div>
              <div className="hbar-track">
                <div className="hbar-fill" style={{ width: `${(g.total / (data.groups[0]?.total || 1)) * 100}%`, background: theme.violet }} />
              </div>
              <div className="hbar-val">{czk(g.total)}</div>
            </div>
          ))}
          <div className="card-note">Hover a group to see its categories.</div>
        </div>
        <div className="card">
          <h3>Top categories</h3>
          {data.categories.slice(0, 10).map((c: any) => (
            <div className="hbar-row" key={c.category}>
              <div className="hbar-label" title={c.category}>{c.category}</div>
              <div className="hbar-track">
                <div className="hbar-fill" style={{ width: `${(c.total / maxCat) * 100}%`, background: theme.accent }} />
              </div>
              <div className="hbar-val">{czk(c.total)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Full breakdown <span className="muted small">(click a row for its transactions)</span></h3>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th></th><th>Category</th><th>Group</th><th className="num">Total</th><th className="num"># Txns</th>
                <th className="num">Avg / txn</th><th className="num">% of spend</th>
                {month !== 'all' && <th className="num">Avg / day</th>}
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c: any) => (
                <Fragment key={c.category}>
                  <tr className="clickable" onClick={() => toggle(c.category)}>
                    <td className="muted">{open.has(c.category) ? '▾' : '▸'}</td>
                    <td>{c.category}</td>
                    <td className="muted">{c.grp}</td>
                    <td className="num">{czk(c.total)}</td>
                    <td className="num">{c.count}</td>
                    <td className="num">{czk(c.avgPerTxn)}</td>
                    <td className="num">{pct(c.pctOfTotal)}</td>
                    {month !== 'all' && <td className="num">{czk(c.avgPerDay)}</td>}
                  </tr>
                  {open.has(c.category) && c.transactions.map((t: any) => (
                    <tr key={t.id} style={{ background: 'var(--bg)' }}>
                      <td></td>
                      <td className="mono small">{dateLabel(t.date)}</td>
                      <td colSpan={2}>{t.description} <span className="muted small">· {t.account}</span></td>
                      <td className="num small">{num(t.amount)} {t.currency}</td>
                      <td className="num" colSpan={2}>{czk(t.amount_czk)}</td>
                      {month !== 'all' && <td></td>}
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr className="total-row">
                <td></td><td>TOTAL</td><td></td>
                <td className="num">{czk(data.total)}</td>
                <td className="num">{data.categories.reduce((s: number, c: any) => s + c.count, 0)}</td>
                <td colSpan={month !== 'all' ? 3 : 2}></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
