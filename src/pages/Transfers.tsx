import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { czk, dateLabel, num } from '../format';
import { Toast, useToast } from '../components/ui';

interface TRow {
  id: number; date: string; description: string; account: string;
  amount: number; currency: string; amount_czk: number | null;
  transfer_pair_id: number | null; transfer_role: string | null;
}

export default function Transfers() {
  const [pairs, setPairs] = useState<{ out: TRow; in: TRow; feeCzk: number }[]>([]);
  const [unpaired, setUnpaired] = useState<TRow[]>([]);
  const [linkSel, setLinkSel] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [toast, showToast] = useToast();

  const load = useCallback(() => {
    api.get('/api/transfers').then((d) => { setPairs(d.pairs); setUnpaired(d.unpaired); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const match = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/transfers/match');
      showToast(`Matched ${r.paired} pairs (${r.crossCurrency} cross-currency) · ${r.unpaired} rows left unpaired`);
      load();
    } finally { setBusy(false); }
  };

  const reset = async () => {
    if (!confirm('Clear all transfer pairings (including manual ones) and start over?')) return;
    await api.post('/api/transfers/reset');
    load();
  };

  const flip = async (id: number) => { await api.put('/api/transfers/flip', { id }); load(); };
  const unlink = async (id: number) => { await api.put('/api/transfers/unlink', { id }); load(); };
  const setRole = async (id: number, role: string) => {
    await api.put('/api/transfers/role', { id, role: role || null });
    load();
  };
  const link = async (row: TRow, asSender: boolean) => {
    const otherId = linkSel[row.id];
    if (!otherId) { showToast('Pick a counterpart row first'); return; }
    await api.put('/api/transfers/link', asSender ? { outId: row.id, inId: otherId } : { outId: otherId, inId: row.id });
    showToast('Linked');
    load();
  };

  const unresolved = unpaired.filter((r) => r.transfer_role == null).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Transfers</h2>
          <div className="sub">
            {pairs.length} matched pairs · {unpaired.length} unpaired rows{unresolved > 0 ? ` (${unresolved} unresolved — excluded from balances)` : ''}
          </div>
        </div>
        <div className="head-controls">
          <button onClick={reset}>Reset pairing</button>
          <button className="primary" onClick={match} disabled={busy}>{busy ? 'Matching…' : '⇄ Auto-match'}</button>
        </div>
      </div>

      <div className="callout">
        Each transfer is two rows — money leaving one account and arriving at another, sometimes in a different
        currency. Matching credits the destination with what actually arrived; the difference is the conversion fee.
        Directions come from fees, statement wording and dates — flip any pair that's wrong.
      </div>

      <div className="card">
        <h3>Matched pairs</h3>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Sent</th><th>From</th><th className="num">Amount out</th>
                <th></th>
                <th>To</th><th className="num">Amount in</th><th className="num">Fee / slippage</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((p) => (
                <tr key={p.out.id}>
                  <td className="mono">
                    {dateLabel(p.out.date)}
                    {p.in.date !== p.out.date && <div className="muted small">→ {dateLabel(p.in.date)}</div>}
                  </td>
                  <td>{p.out.account}</td>
                  <td className="num">{num(p.out.amount)} {p.out.currency}</td>
                  <td style={{ color: 'var(--accent)' }}>→</td>
                  <td>{p.in.account}</td>
                  <td className="num">
                    {num(p.in.amount)} {p.in.currency}
                    {p.in.currency !== p.out.currency && <span className="badge transfer" style={{ marginLeft: 6 }}>FX</span>}
                  </td>
                  <td className="num muted">{Math.abs(p.feeCzk) < 0.5 ? '—' : czk(p.feeCzk)}</td>
                  <td className="num">
                    <button className="small" title="Swap direction" onClick={() => flip(p.out.id)}>⇄ Flip</button>{' '}
                    <button className="small danger" title="Unlink pair" onClick={() => unlink(p.out.id)}>Unlink</button>
                  </td>
                </tr>
              ))}
              {pairs.length === 0 && <tr><td colSpan={8} className="empty">No pairs yet — run auto-match.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>Unpaired rows <span className="muted small">(set a direction, or link with the matching side)</span></h3>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th><th>Account</th><th>Description</th><th className="num">Amount</th><th className="num">CZK</th>
                <th>Direction</th><th>Link with…</th><th></th>
              </tr>
            </thead>
            <tbody>
              {unpaired.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{dateLabel(r.date)}</td>
                  <td>{r.account}</td>
                  <td className="muted">{r.description}</td>
                  <td className="num">{num(r.amount)} {r.currency}</td>
                  <td className="num">{czk(r.amount_czk)}</td>
                  <td>
                    <select value={r.transfer_role ?? ''} onChange={(e) => setRole(r.id, e.target.value)}>
                      <option value="">Unresolved (excluded)</option>
                      <option value="out">Money out</option>
                      <option value="in">Money in</option>
                    </select>
                  </td>
                  <td>
                    <select
                      value={linkSel[r.id] ?? ''}
                      onChange={(e) => setLinkSel({ ...linkSel, [r.id]: Number(e.target.value) })}
                      style={{ maxWidth: 240 }}
                    >
                      <option value="">— pick counterpart —</option>
                      {unpaired.filter((o) => o.id !== r.id && o.account !== r.account).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.date} · {o.account} · {num(o.amount)} {o.currency}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button className="small" title="This row is the sending side" onClick={() => link(r, true)}>Send →</button>{' '}
                    <button className="small" title="This row is the receiving side" onClick={() => link(r, false)}>← Receive</button>
                  </td>
                </tr>
              ))}
              {unpaired.length === 0 && <tr><td colSpan={8} className="empty">Everything is paired 🎉</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card-note">
          One-sided transfers (e.g. the other side arrives next month, or goes to an account you don't track) can just
          be marked "Money out" / "Money in" — that's enough for balances.
        </div>
      </div>
      <Toast msg={toast} />
    </>
  );
}
