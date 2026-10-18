import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { czk, dateLabel, num, todayStr } from '../format';
import { Account, Category, Necessity, Tx, CURRENCIES } from '../types';
import { notifyNecessityChanged } from './Sort';
import { Modal, MonthPicker, Toast, TypeBadge, useToast } from '../components/ui';

const PAGE = 100;

const emptyTx = (): Partial<Tx> => ({
  date: todayStr(), description: '', account: '', category: null, amount: 0,
  currency: 'CZK', fx_rate: null, type: 'Expense', entity: null, notes: null,
});

export default function Transactions() {
  const [rows, setRows] = useState<Tx[]>([]);
  const [total, setTotal] = useState(0);
  const [sums, setSums] = useState({ income: 0, expenses: 0 });
  const [page, setPage] = useState(0);
  const [month, setMonth] = useState('all');
  const [account, setAccount] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [necessity, setNecessity] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<Partial<Tx> | null>(null);
  const [toast, showToast] = useToast();

  useEffect(() => {
    api.get<Account[]>('/api/accounts').then(setAccounts);
    api.get<Category[]>('/api/categories').then(setCategories);
  }, []);

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (month !== 'all') q.set('month', month);
    if (account) q.set('account', account);
    if (category) q.set('category', category);
    if (type) q.set('type', type);
    if (search) q.set('search', search);
    if (necessity) q.set('necessity', necessity);
    q.set('limit', String(PAGE));
    q.set('offset', String(page * PAGE));
    api.get(`/api/transactions?${q}`).then((d) => {
      setRows(d.rows);
      setTotal(d.total);
      setSums({ income: d.income, expenses: d.expenses });
    });
  }, [month, account, category, type, search, necessity, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [month, account, category, type, search, necessity]);

  const setRowNecessity = async (t: Tx, value: Necessity | null) => {
    try {
      const updated = await api.put<Tx>(`/api/transactions/${t.id}/necessity`, { necessity: value });
      notifyNecessityChanged();
      // Keep the row in view unless the active filter now excludes it.
      if (necessity) load();
      else setRows((rs) => rs.map((r) => (r.id === t.id ? updated : r)));
    } catch (e: any) {
      showToast(`Couldn't save: ${e.message}`);
    }
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.date || !editing.account || !editing.amount) {
      showToast('Date, account and amount are required');
      return;
    }
    try {
      if (editing.id) await api.put(`/api/transactions/${editing.id}`, editing);
      else await api.post('/api/transactions', editing);
      setEditing(null);
      showToast('Saved — CZK amount converted at the daily rate');
      load();
    } catch (e: any) {
      showToast(`Save failed: ${e.message}`);
    }
  };

  const remove = async (t: Tx) => {
    if (!confirm(`Delete "${t.description}" (${t.amount} ${t.currency}) on ${t.date}?`)) return;
    await api.del(`/api/transactions/${t.id}`);
    load();
  };

  const pages = Math.ceil(total / PAGE);
  const expenseCats = useMemo(() => categories.filter((c) => c.type !== 'Income'), [categories]);
  const catsForType = editing?.type === 'Income' ? categories.filter((c) => c.type === 'Income') : editing?.type === 'Transfer' ? categories : expenseCats;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Transactions</h2>
          <div className="sub">{total} matching · income {czk(sums.income)} · expenses {czk(sums.expenses)}</div>
        </div>
        <button className="primary" onClick={() => setEditing(emptyTx())}>+ Add transaction</button>
      </div>

      <div className="filters">
        <label className="fld">Month<MonthPicker value={month} onChange={setMonth} allowAll /></label>
        <label className="fld">Account
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">All</option>
            {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
        </label>
        <label className="fld">Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label className="fld">Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            <option>Expense</option><option>Income</option><option>Transfer</option>
          </select>
        </label>
        <label className="fld">Need/want
          <select value={necessity} onChange={(e) => setNecessity(e.target.value)}>
            <option value="">All</option>
            <option value="need">Need</option>
            <option value="want">Want</option>
            <option value="unsorted">Unsorted</option>
          </select>
        </label>
        <label className="fld">Search
          <input placeholder="Description or notes…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>

      <div className="card">
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th><th>Description</th><th>Account</th><th>Category</th>
                <th className="num">Amount</th><th className="num">Rate</th><th className="num">CZK</th>
                <th>Type</th><th>Need/want</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{dateLabel(t.date)}</td>
                  <td>
                    {t.description}
                    {t.recurring ? <span className="badge neutral" style={{ marginLeft: 6 }}>↻</span> : null}
                    {t.notes && <div className="muted small">{t.notes}</div>}
                  </td>
                  <td className="muted">{t.account}</td>
                  <td className="muted">{t.category ?? '—'}</td>
                  <td className="num">{num(t.amount)} {t.currency}</td>
                  <td className="num muted">{t.currency === 'CZK' ? '1' : t.fx_rate != null ? num(t.fx_rate, 2) : <span className="badge warn">missing</span>}</td>
                  <td className="num">{czk(t.amount_czk)}</td>
                  <td><TypeBadge type={t.type} /></td>
                  <td>
                    {t.type === 'Expense' ? (
                      <select
                        className={`necessity-select ${t.necessity ?? 'unsorted'}`}
                        aria-label={`Need or want: ${t.description}`}
                        value={t.necessity ?? ''}
                        onChange={(e) => setRowNecessity(t, (e.target.value || null) as Necessity | null)}
                      >
                        <option value="">—</option>
                        <option value="need">Need</option>
                        <option value="want">Want</option>
                      </select>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td className="num">
                    <button className="small" onClick={() => setEditing({ ...t })}>Edit</button>{' '}
                    <button className="small danger" onClick={() => remove(t)}>✕</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={10} className="empty">No transactions match.</td></tr>}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="row mt8">
            <button className="small" disabled={page === 0} onClick={() => setPage(page - 1)}>← Prev</button>
            <span className="muted small">Page {page + 1} of {pages}</span>
            <button className="small" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next →</button>
          </div>
        )}
      </div>

      {editing && (
        <Modal title={editing.id ? 'Edit transaction' : 'Add transaction'} onClose={() => setEditing(null)}>
          <div className="form-grid">
            <label className="fld">Date
              <input type="date" value={editing.date ?? ''} onChange={(e) => setEditing({ ...editing, date: e.target.value })} />
            </label>
            <label className="fld">Type
              <select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as Tx['type'] })}>
                <option>Expense</option><option>Income</option><option>Transfer</option>
              </select>
            </label>
            <label className="fld full">Description
              <input value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <label className="fld">Account
              <select value={editing.account ?? ''} onChange={(e) => {
                const acc = accounts.find((a) => a.name === e.target.value);
                setEditing({ ...editing, account: e.target.value, entity: acc?.entity ?? editing.entity, currency: editing.id ? editing.currency : acc?.base_currency ?? editing.currency });
              }}>
                <option value="">— select —</option>
                {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
              </select>
            </label>
            <label className="fld">Category
              <select value={editing.category ?? ''} onChange={(e) => setEditing({ ...editing, category: e.target.value || null })}>
                <option value="">— none —</option>
                {catsForType.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </label>
            <label className="fld">Amount
              <input type="number" step="0.01" value={editing.amount ?? ''} onChange={(e) => setEditing({ ...editing, amount: parseFloat(e.target.value) })} />
            </label>
            <label className="fld">Currency
              <select value={editing.currency} onChange={(e) => setEditing({ ...editing, currency: e.target.value, fx_rate: null })}>
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label className="fld">FX rate to CZK <span className="muted">(blank = fetch daily rate)</span>
              <input type="number" step="0.0001" value={editing.fx_rate ?? ''} placeholder="auto"
                onChange={(e) => setEditing({ ...editing, fx_rate: e.target.value === '' ? null : parseFloat(e.target.value) })} />
            </label>
            <label className="fld">Entity
              <input value={editing.entity ?? ''} onChange={(e) => setEditing({ ...editing, entity: e.target.value || null })} />
            </label>
            <label className="fld full">Notes
              <input value={editing.notes ?? ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value || null })} />
            </label>
          </div>
          <div className="modal-actions">
            <button onClick={() => setEditing(null)}>Cancel</button>
            <button className="primary" onClick={save}>Save</button>
          </div>
        </Modal>
      )}
      <Toast msg={toast} />
    </>
  );
}
