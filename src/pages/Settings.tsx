import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { num } from '../format';
import { Account, Category, CURRENCIES } from '../types';
import { Modal, Toast, useToast } from '../components/ui';

export default function Settings() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editAcc, setEditAcc] = useState<Partial<Account> | null>(null);
  const [editCat, setEditCat] = useState<Partial<Category> | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetBackup, setResetBackup] = useState<string | null>(null);
  const [toast, showToast] = useToast();

  const load = useCallback(() => {
    api.get<Account[]>('/api/accounts').then(setAccounts);
    api.get<Category[]>('/api/categories').then(setCategories);
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveAcc = async () => {
    if (!editAcc?.name?.trim()) { showToast('Account name is required'); return; }
    try {
      if (editAcc.id) await api.put(`/api/accounts/${editAcc.id}`, editAcc);
      else await api.post('/api/accounts', editAcc);
      setEditAcc(null);
      load();
    } catch (e: any) { showToast(`Save failed: ${e.message}`); }
  };

  const saveCat = async () => {
    if (!editCat?.name?.trim()) { showToast('Category name is required'); return; }
    try {
      if (editCat.id) await api.put(`/api/categories/${editCat.id}`, editCat);
      else await api.post('/api/categories', editCat);
      setEditCat(null);
      load();
    } catch (e: any) { showToast(`Save failed: ${e.message}`); }
  };

  const delAcc = async (a: Account) => {
    if (!confirm(`Delete account "${a.name}"? Its transactions keep the name but lose the link.`)) return;
    await api.del(`/api/accounts/${a.id}`);
    load();
  };
  const delCat = async (c: Category) => {
    if (!confirm(`Delete category "${c.name}"? Transactions keep the name.`)) return;
    await api.del(`/api/categories/${c.id}`);
    load();
  };

  const resetDb = async () => {
    setResetting(true);
    try {
      const { backup } = await api.post<{ backup: string }>('/api/maintenance/reset', { confirm: resetText });
      setResetOpen(false);
      setResetText('');
      setResetBackup(backup);
      load();
    } catch (e: any) {
      showToast(`Reset failed: ${e.message}`);
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div><h2>Settings</h2><div className="sub">Accounts, categories and your database. Renames propagate to existing transactions automatically</div></div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Accounts</h3>
          <button className="small primary" onClick={() => setEditAcc({ name: '', type: 'Personal', base_currency: 'CZK', opening_balance: 0 })}>+ Add account</button>
        </div>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Type</th><th>Business / entity</th><th>Base currency</th><th className="num">Opening balance</th><th></th></tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td><span className="badge neutral">{a.type}</span></td>
                  <td className="muted">{a.entity ?? '—'}</td>
                  <td>{a.base_currency}</td>
                  <td className="num">{num(a.opening_balance)} {a.base_currency}</td>
                  <td className="num">
                    <button className="small" onClick={() => setEditAcc({ ...a })}>Edit</button>{' '}
                    <button className="small danger" onClick={() => delAcc(a)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Categories</h3>
          <button className="small primary" onClick={() => setEditCat({ name: '', type: 'Expense', grp: 'Other' })}>+ Add category</button>
        </div>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Type</th><th>Group</th><th></th></tr></thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td><span className={`badge ${c.type === 'Income' ? 'income' : c.type === 'Transfer' ? 'transfer' : 'expense'}`}>{c.type}</span></td>
                  <td className="muted">{c.grp}</td>
                  <td className="num">
                    <button className="small" onClick={() => setEditCat({ ...c })}>Edit</button>{' '}
                    <button className="small danger" onClick={() => delCat(c)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>Database</h3>
        <p className="small muted" style={{ marginTop: 0 }}>Everything is stored in one file on this computer.</p>
        <div className="row">
          <a className="btn" href="/api/maintenance/backup" download>Back up database</a>
          <span className="small muted">Saves a copy you can restore with File → Import database…</span>
        </div>
        <div className="row mt16">
          <button className="danger" onClick={() => { setResetText(''); setResetOpen(true); }}>Reset database…</button>
          <span className="small muted">Deletes every transaction, account, category, template and budget.</span>
        </div>
        {resetBackup && (
          <div className="callout mt16" role="status">
            Database reset. Your previous data was kept as <span className="mono">{resetBackup}</span>
          </div>
        )}
      </div>

      {resetOpen && (
        <Modal title="Reset database?" onClose={() => setResetOpen(false)}>
          <p>
            This deletes <b>all</b> your data and starts over with an empty database. A copy of the current database is
            kept in the data folder first, so you can restore it with File → Import database….
          </p>
          <label className="fld full">Type RESET to confirm
            <input value={resetText} autoFocus onChange={(e) => setResetText(e.target.value)} />
          </label>
          <div className="modal-actions">
            <button onClick={() => setResetOpen(false)}>Cancel</button>
            <button className="danger" disabled={resetText !== 'RESET' || resetting} onClick={resetDb}>
              {resetting ? 'Resetting…' : 'Reset database'}
            </button>
          </div>
        </Modal>
      )}

      {editAcc && (
        <Modal title={editAcc.id ? 'Edit account' : 'Add account'} onClose={() => setEditAcc(null)}>
          <div className="form-grid">
            <label className="fld full">Name<input value={editAcc.name ?? ''} onChange={(e) => setEditAcc({ ...editAcc, name: e.target.value })} /></label>
            <label className="fld">Type
              <select value={editAcc.type} onChange={(e) => setEditAcc({ ...editAcc, type: e.target.value })}>
                <option>Personal</option><option>Business</option>
              </select>
            </label>
            <label className="fld">Base currency
              <select value={editAcc.base_currency} onChange={(e) => setEditAcc({ ...editAcc, base_currency: e.target.value })}>
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label className="fld">Business / entity<input value={editAcc.entity ?? ''} onChange={(e) => setEditAcc({ ...editAcc, entity: e.target.value || null })} /></label>
            <label className="fld">Opening balance<input type="number" step="0.01" value={editAcc.opening_balance ?? 0} onChange={(e) => setEditAcc({ ...editAcc, opening_balance: +e.target.value })} /></label>
          </div>
          <div className="modal-actions">
            <button onClick={() => setEditAcc(null)}>Cancel</button>
            <button className="primary" onClick={saveAcc}>Save</button>
          </div>
        </Modal>
      )}

      {editCat && (
        <Modal title={editCat.id ? 'Edit category' : 'Add category'} onClose={() => setEditCat(null)}>
          <div className="form-grid">
            <label className="fld full">Name<input value={editCat.name ?? ''} onChange={(e) => setEditCat({ ...editCat, name: e.target.value })} /></label>
            <label className="fld">Type
              <select value={editCat.type} onChange={(e) => setEditCat({ ...editCat, type: e.target.value })}>
                <option>Expense</option><option>Income</option><option>Transfer</option>
              </select>
            </label>
            <label className="fld">Group<input value={editCat.grp ?? ''} onChange={(e) => setEditCat({ ...editCat, grp: e.target.value })} list="grp-list" /></label>
            <datalist id="grp-list">
              {[...new Set(categories.map((c) => c.grp))].map((g) => <option key={g} value={g} />)}
            </datalist>
          </div>
          <div className="modal-actions">
            <button onClick={() => setEditCat(null)}>Cancel</button>
            <button className="primary" onClick={saveCat}>Save</button>
          </div>
        </Modal>
      )}
      <Toast msg={toast} />
    </>
  );
}
