import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { dateLabel, num } from '../format';
import { Account, Category, RuleAudit, RuleDraft, RuleListItem, RulePreview, RuleVersion } from '../types';
import { Modal, Toast, TypeBadge, useToast } from '../components/ui';

// Category rules (#3488). The rules themselves run on the server (server/rules.ts): on import, on
// "Apply rules now", and when a rule is saved or rolled back. They never change a category the user set.

const EMPTY: RuleDraft = { match: 'contains', text: '', account: null, type: 'Expense', amount_min: null, amount_max: null, category: '' };

export function amountLabel(r: RuleDraft): string {
  if (r.amount_min != null && r.amount_max != null) return `${num(r.amount_min)} – ${num(r.amount_max)}`;
  if (r.amount_min != null) return `≥ ${num(r.amount_min)}`;
  if (r.amount_max != null) return `≤ ${num(r.amount_max)}`;
  return 'Any';
}

const categoryChanged = () => window.dispatchEvent(new Event('category-changed'));
export const rowsLabel = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

export default function Rules() {
  const [rules, setRules] = useState<RuleListItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<{ id: number | null; draft: RuleDraft } | null>(null);
  const [historyOf, setHistoryOf] = useState<RuleListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, showToast] = useToast();

  const load = useCallback(() => {
    api.get<RuleListItem[]>('/api/rules').then(setRules);
  }, []);
  useEffect(() => {
    load();
    api.get<Account[]>('/api/accounts').then(setAccounts);
    api.get<Category[]>('/api/categories').then(setCategories);
  }, [load]);

  const applyNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ changed: number; conflicts: number }>('/api/rules/apply');
      showToast(`Rules applied: ${rowsLabel(r.changed)} categorised` + (r.conflicts ? `, ${rowsLabel(r.conflicts)} left alone (rules disagree)` : ''));
      categoryChanged();
      load();
    } catch (e: any) {
      showToast(`Apply failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const retire = async (r: RuleListItem) => {
    try {
      await api.post(`/api/rules/${r.rule_id}/retire`);
      showToast(`Rule "${r.text}" retired. Rows it categorised keep their category.`);
      load();
    } catch (e: any) {
      showToast(`Retire failed: ${e.message}`);
    }
  };

  const done = (msg: string) => {
    setEditing(null);
    setHistoryOf(null);
    showToast(msg);
    categoryChanged();
    load();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Rules</h2>
          <div className="sub">
            Rules give a category to rows by their description. They run on every import and when you apply them.
            They never change a category you set yourself.
          </div>
        </div>
        <div className="row">
          <button onClick={applyNow} disabled={busy || !rules.some((r) => r.status === 'active')}>
            {busy ? 'Applying…' : 'Apply rules now'}
          </button>
          <button className="primary" onClick={() => setEditing({ id: null, draft: EMPTY })}>+ Add rule</button>
        </div>
      </div>

      {rules.length === 0 ? (
        <div className="card empty">
          No rules yet. Click <b>+ Add rule</b> to categorise rows by their description.
        </div>
      ) : (
        <div className="card">
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Description</th><th>Type</th><th>Account</th><th className="num">Amount</th><th>Category</th>
                  <th className="num">Version</th><th className="num">Rows</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.rule_id} style={r.status === 'active' ? undefined : { opacity: 0.5 }}>
                    <td>
                      <span className="badge neutral">{r.match === 'exact' ? 'is' : 'contains'}</span> {r.text}
                    </td>
                    <td><TypeBadge type={r.type} /></td>
                    <td className="muted">{r.account ?? 'Any'}</td>
                    <td className="num muted">{amountLabel(r)}</td>
                    <td>{r.category}</td>
                    <td className="num muted">v{r.version}</td>
                    <td className="num">{r.row_count}</td>
                    <td>{r.status === 'active' ? <span className="badge income">active</span> : <span className="badge neutral">retired</span>}</td>
                    <td className="num">
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="small" onClick={() => setEditing({ id: r.rule_id, draft: r })}>Edit</button>
                        <button className="small" onClick={() => setHistoryOf(r)}>History</button>
                        {r.status === 'active' && <button className="small danger" onClick={() => retire(r)}>Retire</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-note">
            Order: an exact match beats "contains", longer text beats shorter, and a rule for one account beats a
            general one. If two equal rules give different categories, neither applies.
          </div>
        </div>
      )}

      {editing && (
        <RuleEditor
          id={editing.id}
          initial={editing.draft}
          accounts={accounts}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={(applied) => done(`Rule saved: ${rowsLabel(applied)} categorised`)}
        />
      )}
      {historyOf && (
        <RuleHistory
          rule={historyOf}
          onClose={() => setHistoryOf(null)}
          onRolledBack={(version, applied) => done(`Rolled back to v${version}: ${rowsLabel(applied)} changed`)}
        />
      )}
      <Toast msg={toast} />
    </>
  );
}

function PreviewRows({ preview }: { preview: RulePreview }) {
  if (!preview.rows.length) return null;
  return (
    <div className="tbl-scroll mt8" style={{ maxHeight: 240 }}>
      <table className="tbl small">
        <thead>
          <tr><th>Date</th><th>Description</th><th>Account</th><th className="num">Amount</th><th>Category</th></tr>
        </thead>
        <tbody>
          {preview.rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{dateLabel(r.date)}</td>
              <td>{r.description}</td>
              <td className="muted">{r.account}</td>
              <td className="num">{num(r.amount)} {r.currency}</td>
              <td>{r.from ?? <span className="muted">none</span>} → <b>{r.to}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview.count > preview.rows.length && (
        <div className="muted small mt8">and {preview.count - preview.rows.length} more</div>
      )}
    </div>
  );
}

// `submit` replaces the save (the Inbox uses it to accept an edited rule suggestion).
export function RuleEditor({ id, initial, accounts, categories, onClose, onSaved, submit, title }: {
  id: number | null;
  initial: RuleDraft;
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: (applied: number) => void;
  submit?: (draft: RuleDraft) => Promise<{ applied: number }>;
  title?: string;
}) {
  const [draft, setDraft] = useState<RuleDraft>({
    match: initial.match, text: initial.text, account: initial.account, type: initial.type,
    amount_min: initial.amount_min, amount_max: initial.amount_max, category: initial.category,
  });
  const [preview, setPreview] = useState<{ key: string; data: RulePreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const key = JSON.stringify(draft);
  const complete = draft.text.trim() !== '' && draft.category !== '';

  // The preview follows the form: what saving would change, before you save.
  useEffect(() => {
    if (!complete) return;
    let stale = false;
    const t = setTimeout(() => {
      api.post<RulePreview>('/api/rules/preview', { id, draft: JSON.parse(key) })
        .then((data) => { if (!stale) { setPreview({ key, data }); setError(null); } })
        .catch((e) => { if (!stale) { setPreview(null); setError(e.message); } });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [key, id, complete]);

  const fresh = complete && preview?.key === key ? preview.data : null;
  const set = (patch: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const amount = (v: string) => (v === '' ? null : Number(v));

  const save = async () => {
    setSaving(true);
    try {
      const res = submit
        ? await submit(draft)
        : id == null
        ? await api.post<{ applied: number }>('/api/rules', { draft })
        : await api.put<{ applied: number }>(`/api/rules/${id}`, { draft });
      onSaved(res.applied);
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={title ?? (id == null ? 'Add rule' : 'Edit rule')} onClose={onClose}>
      <div className="form-grid">
        <label className="fld">Match
          <select value={draft.match} onChange={(e) => set({ match: e.target.value as RuleDraft['match'] })}>
            <option value="contains">Description contains</option>
            <option value="exact">Description is exactly</option>
          </select>
        </label>
        <label className="fld">Text<input value={draft.text} onChange={(e) => set({ text: e.target.value })} placeholder="e.g. albert" /></label>
        <label className="fld">Type
          <select
            value={draft.type}
            onChange={(e) => {
              const type = e.target.value as RuleDraft['type'];
              set({ type, category: categories.some((c) => c.name === draft.category && c.type === type) ? draft.category : '' });
            }}
          >
            <option>Expense</option>
            <option>Income</option>
          </select>
        </label>
        <label className="fld">Category
          <select value={draft.category} onChange={(e) => set({ category: e.target.value })}>
            <option value="">Choose…</option>
            {categories.filter((c) => c.type === draft.type).map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label className="fld full">Account
          <select value={draft.account ?? ''} onChange={(e) => set({ account: e.target.value || null })}>
            <option value="">Any account</option>
            {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
        </label>
        <label className="fld">Min amount
          <input type="number" min="0" step="0.01" value={draft.amount_min ?? ''} onChange={(e) => set({ amount_min: amount(e.target.value) })} placeholder="Any" />
        </label>
        <label className="fld">Max amount
          <input type="number" min="0" step="0.01" value={draft.amount_max ?? ''} onChange={(e) => set({ amount_max: amount(e.target.value) })} placeholder="Any" />
        </label>
      </div>
      <div className="muted small mt8">Amounts are compared without their sign. Text is matched without regard to case.</div>

      <div className="mt16" data-testid="rule-preview">
        {error ? (
          <div className="badge expense">{error}</div>
        ) : !complete ? (
          <div className="muted small">Enter the text and a category to see which rows this rule would change.</div>
        ) : !fresh ? (
          <div className="muted small">Checking which rows would change…</div>
        ) : (
          <>
            <div><b>{rowsLabel(fresh.count)}</b> would change when you save.</div>
            {fresh.conflicts > 0 && (
              <div className="muted small">{rowsLabel(fresh.conflicts)} match rules that disagree, so they stay as they are.</div>
            )}
            <PreviewRows preview={fresh} />
          </>
        )}
      </div>

      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!fresh || saving} onClick={save}>{saving ? 'Saving…' : 'Save rule'}</button>
      </div>
    </Modal>
  );
}

function RuleHistory({ rule, onClose, onRolledBack }: {
  rule: RuleListItem;
  onClose: () => void;
  onRolledBack: (version: number, applied: number) => void;
}) {
  const [detail, setDetail] = useState<{ current_version: number; versions: RuleVersion[]; audit: RuleAudit[] } | null>(null);
  const [pending, setPending] = useState<{ version: number; preview: RulePreview } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get(`/api/rules/${rule.rule_id}`).then(setDetail).catch((e) => setError(e.message));
  }, [rule.rule_id]);

  const ask = async (version: number) => {
    setError(null);
    try {
      setPending({ version, preview: await api.post<RulePreview>(`/api/rules/${rule.rule_id}/rollback/preview`, { version }) });
    } catch (e: any) {
      setError(e.message);
    }
  };

  const rollback = async (version: number) => {
    try {
      const res = await api.post<{ applied: number }>(`/api/rules/${rule.rule_id}/rollback`, { version });
      onRolledBack(version, res.applied);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <Modal title={`History: ${rule.text}`} onClose={onClose}>
      {error && <div className="badge expense">{error}</div>}
      {detail && (
        <>
          <div className="tbl-scroll">
            <table className="tbl small">
              <thead>
                <tr><th>Version</th><th>Rule</th><th>Category</th><th>Saved</th><th></th></tr>
              </thead>
              <tbody>
                {detail.versions.map((v) => (
                  <tr key={v.version}>
                    <td className="mono">v{v.version}</td>
                    <td>
                      {v.match === 'exact' ? 'is' : 'contains'} "{v.text}"
                      <div className="muted">{v.type}, {v.account ?? 'any account'}, amount {amountLabel(v)}</div>
                    </td>
                    <td>{v.category}</td>
                    <td className="mono muted">{v.created_at}</td>
                    <td className="num">
                      {v.version === detail.current_version
                        ? <span className="badge neutral">current</span>
                        : <button className="small" onClick={() => ask(v.version)}>Roll back to v{v.version}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pending && (
            <div className="card mt16" data-testid="rollback-preview">
              <div>
                Rolling back to v{pending.version} writes it as a new version and re-checks the rows this rule set:{' '}
                <b>{rowsLabel(pending.preview.count)}</b> would change.
              </div>
              <PreviewRows preview={pending.preview} />
              <div className="modal-actions">
                <button onClick={() => setPending(null)}>Cancel</button>
                <button className="primary" onClick={() => rollback(pending.version)}>Roll back</button>
              </div>
            </div>
          )}

          <h4 className="mt16">Audit log</h4>
          <ul className="small" style={{ color: 'var(--ink-2)' }}>
            {detail.audit.map((a) => (
              <li key={a.id}>
                <span className="mono">{a.at}</span> {a.action}{a.version != null ? ` (v${a.version})` : ''} by {a.actor}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="modal-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
