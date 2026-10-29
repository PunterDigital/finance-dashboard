import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { dateLabel, num } from '../format';
import { Account, Category, RuleDraft, RulePreview, Suggestion } from '../types';
import { Toast, useToast } from '../components/ui';
import { RuleEditor, amountLabel, rowsLabel } from './Rules';

// Suggestions waiting for a decision (#3489). Accept runs the kind's handler on the server, Edit (rules
// only) accepts the user's changed version, Reject drops it. Payload text can come from bank
// descriptions, so everything here is rendered as plain React text: never as HTML or a link.

const SECTIONS: { kind: string; title: string }[] = [
  { kind: 'rule', title: 'Rule proposals' },
  { kind: 'price_change', title: 'Price changes' },
  { kind: 'recurring_stopped', title: 'Payments that may have stopped' },
];
const KNOWN = new Set(SECTIONS.map((s) => s.kind));
const changed = () => {
  window.dispatchEvent(new Event('suggestions-changed'));
  window.dispatchEvent(new Event('category-changed'));
};

export default function Inbox() {
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<Suggestion | null>(null);
  const [toast, showToast] = useToast();

  const load = useCallback(() => {
    api.get<Suggestion[]>('/api/suggestions').then(setItems);
  }, []);
  useEffect(() => {
    load();
    api.get<Account[]>('/api/accounts').then(setAccounts);
    api.get<Category[]>('/api/categories').then(setCategories);
  }, [load]);

  const decide = async (s: Suggestion, action: 'accept' | 'reject') => {
    try {
      const res = await api.post(`/api/suggestions/${s.id}/${action}`);
      const applied = res.result?.applied;
      showToast(action === 'reject' ? 'Rejected' : applied != null ? `Accepted: ${rowsLabel(applied)} categorised` : 'Accepted');
    } catch (e: any) {
      showToast(`${action === 'accept' ? 'Accept' : 'Reject'} failed: ${e.message}`);
    }
    changed();
    load();
  };

  const sections = [
    ...SECTIONS,
    ...[...new Set((items ?? []).map((s) => s.kind).filter((k) => !KNOWN.has(k)))].map((kind) => ({ kind, title: `Other: ${kind}` })),
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Inbox</h2>
          <div className="sub">Suggestions from the app. Nothing changes until you accept one.</div>
        </div>
      </div>

      {items && items.length === 0 && (
        <div className="card empty">
          Nothing to review. Price changes and payments that may have stopped show up here after you run
          <b> Detect recurring</b>.
        </div>
      )}

      {items && sections.map(({ kind, title }) => {
        const list = items.filter((s) => s.kind === kind);
        if (!list.length) return null;
        return (
          <section className="card" key={kind} aria-label={title}>
            <h3>{title} <span className="muted small">{list.length}</span></h3>
            <ul className="inbox-list">
              {list.map((s) => (
                <li key={s.id} className="inbox-item" data-testid="suggestion">
                  <div className="inbox-text">
                    <SuggestionText s={s} />
                  </div>
                  <div className="row">
                    {KNOWN.has(s.kind) && <button className="small primary" onClick={() => decide(s, 'accept')}>Accept</button>}
                    {s.kind === 'rule' && <button className="small" onClick={() => setEditing(s)}>Edit</button>}
                    <button className="small danger" onClick={() => decide(s, 'reject')}>Reject</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {editing && (
        <RuleEditor
          id={null}
          title="Edit suggested rule"
          initial={editing.payload.draft}
          accounts={accounts}
          categories={categories}
          submit={async (draft) => {
            const res = await api.post(`/api/suggestions/${editing.id}/accept`, { payload: { draft } });
            return { applied: res.result.applied };
          }}
          onClose={() => setEditing(null)}
          onSaved={(applied) => {
            setEditing(null);
            showToast(`Accepted with your changes: ${rowsLabel(applied)} categorised`);
            changed();
            load();
          }}
        />
      )}
      <Toast msg={toast} />
    </>
  );
}

const str = (v: unknown) => (v == null ? '' : String(v));
const money = (amount: unknown, currency: unknown) => `${num(Math.abs(Number(amount)))} ${str(currency)}`.trim();

function SuggestionText({ s }: { s: Suggestion }) {
  const p = s.payload ?? {};
  switch (s.kind) {
    case 'rule':
      return <RuleText draft={p.draft} reason={p.reason} />;
    case 'price_change':
      return (
        <>
          <div><b>{str(p.description)}</b>: the price changed from {money(p.previous_amount, p.currency)} to {money(p.amount, p.currency)} on {dateLabel(str(p.changed_on))}.</div>
          <div className="muted small">Accept keeps the new amount on the Recurring page.</div>
        </>
      );
    case 'recurring_stopped':
      return (
        <>
          <div><b>{str(p.description)}</b>: no {str(p.frequency).toLowerCase() || 'regular'} payment since {dateLabel(str(p.last_seen))} (expected {dateLabel(str(p.next_expected))}).</div>
          <div className="muted small">Accept marks it inactive on the Recurring page.</div>
        </>
      );
    default:
      return (
        <>
          <div className="muted small">The app can't apply this kind of suggestion yet, so you can only reject it.</div>
          <div className="mono small inbox-raw">{JSON.stringify(p).slice(0, 300)}</div>
        </>
      );
  }
}

function RuleText({ draft, reason }: { draft: RuleDraft; reason?: unknown }) {
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.post<RulePreview>('/api/rules/preview', { draft }).then(setPreview).catch((e) => setError(e.message));
  }, [draft]);
  return (
    <>
      <div>
        Set <b>{draft.category}</b> on {draft.type.toLowerCase()} rows whose description {draft.match === 'exact' ? 'is' : 'contains'} "{draft.text}"
        {draft.account ? ` on ${draft.account}` : ''}{amountLabel(draft) !== 'Any' ? `, amount ${amountLabel(draft)}` : ''}.
      </div>
      {reason != null && <div className="muted small">{str(reason)}</div>}
      <div className="small" data-testid="suggestion-preview">
        {error ? <span className="badge expense">{error}</span> : preview ? `${rowsLabel(preview.count)} would change if you accept.` : 'Checking…'}
      </div>
    </>
  );
}
