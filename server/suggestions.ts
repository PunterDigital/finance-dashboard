import { db } from './db.js';
import { RuleError, activeRules, audit, createRule, decide, normalise, parseDraft, type RuleDraft } from './rules.js';
import { recurringStatus } from '../src/recurring-status.js';

// Suggestions for the Inbox (#3489). Code (and later the LLM agent) writes them; nothing changes the
// data until the user accepts one, which runs the handler for its kind. A kind without a handler can
// only be rejected. Payload text can come from bank descriptions: the UI shows it as plain text.

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'edited' | 'expired';

export interface Suggestion {
  id: number;
  kind: string;
  payload: any;
  status: SuggestionStatus;
  created_at: string;
  decided_at: string | null;
  model: string | null;
  prompt_version: string | null;
  run_id: string | null;
}

interface Handler {
  // Whether the user may change the payload before accepting (Edit).
  editable: boolean;
  // Checks a new payload; throws a SuggestionError.
  validate(payload: any): void;
  // True when the suggestion no longer applies (accepting it expires it instead).
  stale?(s: Suggestion): boolean;
  // Applies the suggestion; `edited` is the user's changed payload, if any.
  accept(s: Suggestion, edited: any | null): unknown;
}

export class SuggestionError extends RuleError {}

const recurringGone = (s: Suggestion) => !db.prepare('SELECT 1 FROM recurring WHERE id=?').get(s.payload.recurring_id);

const needsRecurringId = (p: any) => {
  if (!Number.isInteger(p?.recurring_id)) throw new SuggestionError('payload.recurring_id must be a recurring item id');
};

const HANDLERS: Record<string, Handler> = {
  // A category rule. Accepting creates it (and applies it, as saving on the Rules page does).
  rule: {
    editable: true,
    validate: (p) => { parseDraft(p?.draft); },
    accept: (s, edited) => {
      const draft = parseDraft((edited ?? s.payload).draft);
      const author = s.payload.author === 'agent' ? 'agent' : 'auto';
      const created = createRule(draft, author);
      audit(created.id, 1, 'accept', { suggestion_id: s.id, proposed: s.payload.draft }, edited ? { edited: draft } : null);
      return { rule_id: created.id, applied: created.applied };
    },
  },
  // The detector saw a new price. Accepting acknowledges it: the item already has the new amount.
  price_change: {
    editable: false,
    validate: needsRecurringId,
    stale: recurringGone,
    accept: () => ({}),
  },
  // No payment after the grace period. Accepting marks the item inactive.
  recurring_stopped: {
    editable: false,
    validate: needsRecurringId,
    stale: recurringGone,
    accept: (s) => {
      db.prepare('UPDATE recurring SET active=0 WHERE id=?').run(s.payload.recurring_id);
      return {};
    },
  },
};

export const EDITABLE_KINDS = Object.keys(HANDLERS).filter((k) => HANDLERS[k].editable);

function setStatus(id: number, status: SuggestionStatus, payload?: unknown) {
  if (payload === undefined) {
    db.prepare("UPDATE agent_suggestions SET status=?, decided_at=datetime('now') WHERE id=?").run(status, id);
  } else {
    db.prepare("UPDATE agent_suggestions SET status=?, payload_json=?, decided_at=datetime('now') WHERE id=?").run(status, JSON.stringify(payload), id);
  }
}

const fromRow = (r: any): Suggestion => {
  const { payload_json, ...rest } = r;
  return { ...rest, payload: JSON.parse(payload_json) };
};

function get(id: number): Suggestion {
  const r = db.prepare('SELECT * FROM agent_suggestions WHERE id=?').get(id);
  if (!r) throw new SuggestionError('Suggestion not found', 404);
  return fromRow(r);
}

// Adds a suggestion unless one with the same kind and `payload.key` was ever made (so a rejected one
// doesn't come back). Returns the new id, or null for a duplicate.
export function addSuggestion(
  kind: string,
  payload: Record<string, unknown>,
  meta: { model?: string | null; prompt_version?: string | null; run_id?: string | null } = {},
): number | null {
  if (typeof kind !== 'string' || !/^[a-z_]{1,40}$/.test(kind)) throw new SuggestionError('kind must be lower-case letters and _');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SuggestionError('payload must be an object');
  HANDLERS[kind]?.validate(payload);
  if (payload.key != null) {
    const dup = db.prepare("SELECT 1 FROM agent_suggestions WHERE kind=? AND json_extract(payload_json, '$.key')=?").get(kind, String(payload.key));
    if (dup) return null;
  }
  const info = db
    .prepare('INSERT INTO agent_suggestions (kind, payload_json, model, prompt_version, run_id) VALUES (?,?,?,?,?)')
    .run(kind, JSON.stringify(payload), meta.model ?? null, meta.prompt_version ?? null, meta.run_id ?? null);
  return Number(info.lastInsertRowid);
}

export function listSuggestions(status: SuggestionStatus = 'pending'): Suggestion[] {
  return (db.prepare('SELECT * FROM agent_suggestions WHERE status=? ORDER BY created_at, id').all(status) as any[]).map(fromRow);
}

export function pendingCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM agent_suggestions WHERE status='pending'").get() as { n: number }).n;
}

function pending(id: number): Suggestion {
  const s = get(id);
  if (s.status !== 'pending') throw new SuggestionError(`This suggestion is already ${s.status}`, 409);
  return s;
}

// Accept runs the kind's handler. With `edited` (Edit), the user's version is applied instead and kept
// in the payload next to the original.
export function acceptSuggestion(id: number, edited: any | null = null) {
  const first = pending(id);
  if (HANDLERS[first.kind]?.stale?.(first)) {
    setStatus(id, 'expired');
    throw new SuggestionError('This no longer applies, so it has expired', 409);
  }
  return db.transaction(() => {
    const s = pending(id);
    const handler = HANDLERS[s.kind];
    if (!handler) throw new SuggestionError(`"${s.kind}" suggestions can only be rejected`);
    if (edited != null && !handler.editable) throw new SuggestionError(`"${s.kind}" suggestions can't be edited`);
    const result = handler.accept(s, edited);
    if (edited != null) setStatus(id, 'edited', { ...s.payload, edited });
    else setStatus(id, 'accepted');
    return { id, status: edited != null ? 'edited' : 'accepted', result };
  })();
}

export function rejectSuggestion(id: number) {
  pending(id);
  setStatus(id, 'rejected');
  return { id, status: 'rejected' };
}

// How many times the same description must get the same category by hand before a rule is proposed.
export const PROPOSE_AFTER = 3;

// After a category is set by hand (#3490): when rows of this type with the same normalised description
// were given the same category PROPOSE_AFTER times by hand, more often than any other category, and no
// active rule covers any of them, propose an exact rule for it. The key holds the description and the
// category, so a rejected proposal isn't made again, but a different category can be proposed later.
// Returns the new suggestion's id, or null.
export function proposeRuleFor(txId: number | string): number | null {
  const tx = db.prepare('SELECT description, type, category, category_source FROM transactions WHERE id=?').get(txId) as
    { description: string; type: string; category: string | null; category_source: string | null } | undefined;
  if (!tx || tx.category_source !== 'user' || !tx.category?.trim()) return null;
  if (tx.type !== 'Income' && tx.type !== 'Expense') return null;
  const text = normalise(tx.description ?? '');
  if (!text || text.length > 200) return null;
  // SQLite's lower() is ASCII-only, so the description match happens here.
  const rows = (db
    .prepare("SELECT description, account, type, amount, category FROM transactions WHERE type=? AND category_source='user' AND trim(category) != ''")
    .all(tx.type) as { description: string; account: string; type: string; amount: number; category: string }[])
    .filter((r) => normalise(r.description ?? '') === text);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const [category, n] = ranked[0] ?? ['', 0];
  if (category !== tx.category || n < PROPOSE_AFTER || (ranked[1] && ranked[1][1] === n)) return null;
  const rules = activeRules();
  if (rows.some((r) => decide(r, rules))) return null;
  let draft: RuleDraft;
  try {
    draft = parseDraft({ match: 'exact', text, account: null, type: tx.type, amount_min: null, amount_max: null, category });
  } catch {
    return null; // e.g. the category was deleted
  }
  return addSuggestion('rule', {
    key: `auto:${tx.type}:${text}:${category}`,
    draft,
    author: 'auto',
    reason: `You gave this description this category by hand ${n} times.`,
  });
}

// After recurring detection: a notice for each price change and each item that looks stopped. Pending
// notices that no longer hold (the item resumed, or is gone) expire.
export function suggestFromRecurring(today: string): { added: number; expired: number } {
  const items = db.prepare('SELECT * FROM recurring').all() as any[];
  const current = new Set<string>();
  let added = 0;
  for (const item of items) {
    const desc = String(item.description).trim().toLowerCase();
    const base = { recurring_id: item.id, description: item.description, currency: item.currency };
    if (item.previous_amount != null && item.price_changed_on) {
      const key = `price:${desc}:${item.price_changed_on}`;
      current.add(`price_change ${key}`);
      if (addSuggestion('price_change', { key, ...base, previous_amount: item.previous_amount, amount: item.amount, changed_on: item.price_changed_on })) added++;
    }
    if (recurringStatus(item, today) === 'stopped') {
      const key = `stopped:${desc}:${item.next_expected}`;
      current.add(`recurring_stopped ${key}`);
      if (addSuggestion('recurring_stopped', { key, ...base, amount: item.amount, frequency: item.frequency, last_seen: item.last_seen, next_expected: item.next_expected })) added++;
    }
  }
  let expired = 0;
  for (const s of listSuggestions('pending')) {
    if ((s.kind === 'price_change' || s.kind === 'recurring_stopped') && !current.has(`${s.kind} ${s.payload.key}`)) {
      setStatus(s.id, 'expired');
      expired++;
    }
  }
  return { added, expired };
}
