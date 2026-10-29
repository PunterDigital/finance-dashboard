import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { dateLabel, num, todayStr } from '../format';
import { RecurringItem } from '../types';
import { recurringStatus } from '../recurring-status';
import { Toast, useToast } from '../components/ui';

export default function Recurring() {
  const [rows, setRows] = useState<RecurringItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, showToast] = useToast();

  const load = useCallback(() => {
    api.get<RecurringItem[]>('/api/recurring').then(setRows);
  }, []);
  useEffect(() => { load(); }, [load]);

  const detect = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/recurring/detect');
      showToast(`Detection complete: ${r.found} recurring patterns (${r.added} new, ${r.updated} updated)`);
      load();
    } catch (e: any) {
      showToast(`Detection failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (r: RecurringItem) => {
    await api.put(`/api/recurring/${r.id}`, { ...r, active: r.active ? 0 : 1 });
    load();
  };

  const remove = async (r: RecurringItem) => {
    if (!confirm(`Remove recurring item "${r.description}"?`)) return;
    await api.del(`/api/recurring/${r.id}`);
    load();
  };

  const today = todayStr();

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Recurring Transactions</h2>
          <div className="sub">Auto-detected from transaction history (weekly → annual patterns, transfers excluded)</div>
        </div>
        <button className="primary" onClick={detect} disabled={busy}>{busy ? 'Analyzing…' : '↻ Detect recurring'}</button>
      </div>

      {rows.length === 0 ? (
        <div className="card empty">
          Nothing detected yet — click <b>Detect recurring</b> to scan your transaction history.
          <br />Items need at least 2 occurrences at a steady interval.
        </div>
      ) : (
        <div className="card">
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Description</th><th className="num">Amount</th><th>Account</th><th>Category</th>
                  <th>Frequency</th><th>Last seen</th><th>Next expected</th><th className="num">Seen</th><th>Active</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const status = recurringStatus(r, today);
                  return (
                    <tr key={r.id} style={r.active ? undefined : { opacity: 0.5 }}>
                      <td>{r.description}</td>
                      <td className="num">
                        {r.amount != null ? `${num(r.amount)} ${r.currency}` : '—'}
                        {r.previous_amount != null && r.price_changed_on && (
                          <div className="muted small" data-testid="price-change">
                            Price changed from {num(r.previous_amount)} to {num(r.amount ?? 0)} on {dateLabel(r.price_changed_on)}
                          </div>
                        )}
                      </td>
                      <td className="muted">{r.account ?? '—'}</td>
                      <td className="muted">{r.category ?? '—'}</td>
                      <td><span className="badge neutral">{r.frequency ?? '—'}</span></td>
                      <td className="mono">{dateLabel(r.last_seen)}</td>
                      <td className="mono">
                        {dateLabel(r.next_expected)}{' '}
                        {status === 'overdue' && <span className="badge warn">overdue</span>}
                        {status === 'stopped' && <span className="badge expense">missed, maybe stopped</span>}
                      </td>
                      <td className="num muted">{r.occurrences}×</td>
                      <td>
                        <input type="checkbox" checked={r.active === 1} onChange={() => toggleActive(r)} />
                      </td>
                      <td className="num"><button className="small danger" onClick={() => remove(r)}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card-note">
            Re-running detection refreshes amounts and dates but keeps your active/inactive choices.
            Matching transactions get an ↻ badge in the transactions list.
          </div>
        </div>
      )}
      <Toast msg={toast} />
    </>
  );
}
