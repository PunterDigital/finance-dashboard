import { db } from './db.js';

// Category rules (#3488). A rule matches a row's normalised description, exactly or as a substring
// (no regular expressions, so nothing can hang), optionally only on one account and in an amount
// range, and gives it a category. Rules run on import and on "Apply rules now". They only touch rows
// without a category or rows that a rule categorised; a category the user set is never changed.
//
// Precedence: exact before contains, longer text before shorter, account-specific before general.
// When the best-ranked matches disagree on the category, no rule applies and the row stays in the
// Categorise queue (or keeps the category it has).

export type MatchType = 'exact' | 'contains';
export type RuleType = 'Income' | 'Expense';

// What the user edits: one version of a rule.
export interface RuleDraft {
  match: MatchType;
  text: string;
  account: string | null;
  type: RuleType;
  amount_min: number | null;
  amount_max: number | null;
  category: string;
}

export interface RuleVersion extends RuleDraft {
  rule_id: number;
  version: number;
  author: string;
  created_at: string;
}

export interface RuleTx {
  id: number;
  date: string;
  description: string;
  account: string;
  amount: number;
  currency: string;
  type: string;
  category: string | null;
  category_source: string | null;
  category_rule_id: number | null;
  category_rule_version: number | null;
}

export interface RuleChange {
  id: number;
  date: string;
  description: string;
  account: string;
  amount: number;
  currency: string;
  from: string | null;
  to: string;
  rule_id: number;
  version: number;
}

export type Decision = { rule: RuleVersion } | { conflict: RuleVersion[] } | null;

// Case folding beyond ASCII (descriptions are often Czech) and collapsed whitespace.
export function normalise(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('cs');
}

export function matches(r: RuleDraft, tx: Pick<RuleTx, 'description' | 'account' | 'type' | 'amount'>): boolean {
  if (tx.type !== r.type) return false;
  if (r.account != null && tx.account !== r.account) return false;
  const size = Math.abs(tx.amount);
  if (r.amount_min != null && size < r.amount_min) return false;
  if (r.amount_max != null && size > r.amount_max) return false;
  const d = normalise(tx.description);
  return r.match === 'exact' ? d === r.text : d.includes(r.text);
}

// Lower sorts first: exact, then longer text, then account-specific.
function rank(r: RuleDraft): [number, number, number] {
  return [r.match === 'exact' ? 0 : 1, -r.text.length, r.account != null ? 0 : 1];
}

function compareRank(a: RuleDraft, b: RuleDraft): number {
  const ra = rank(a), rb = rank(b);
  return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
}

// Which rule categorises `tx`, if any. Ties on rank with different categories are a conflict.
export function decide(tx: Pick<RuleTx, 'description' | 'account' | 'type' | 'amount'>, rules: RuleVersion[]): Decision {
  const hits = rules.filter((r) => matches(r, tx)).sort((a, b) => compareRank(a, b) || a.rule_id - b.rule_id);
  if (!hits.length) return null;
  const best = hits.filter((r) => compareRank(r, hits[0]) === 0);
  if (new Set(best.map((r) => r.category)).size > 1) return { conflict: best };
  return { rule: best[0] };
}

// Rows a rule may categorise: income and expenses that have no category, or whose category came
// from a rule. Clearing a category also clears its source, so a cleared row is eligible again.
const ELIGIBLE = `type != 'Transfer' AND (category_source = 'rule'
  OR ((category IS NULL OR trim(category) = '') AND (category_source IS NULL OR category_source != 'user')))`;

const TX_COLS = 'id, date, description, account, amount, currency, type, category, category_source, category_rule_id, category_rule_version';

const versionSql = `SELECT v.* FROM rules r JOIN rule_versions v ON v.rule_id = r.id AND v.version = r.current_version`;

// Active rules whose category still exists with the rule's type (a deleted category disables its rules).
export function activeRules(): RuleVersion[] {
  return db
    .prepare(`${versionSql} JOIN categories c ON c.name = v.category AND c.type = v.type WHERE r.status = 'active'`)
    .all() as RuleVersion[];
}

export interface Plan {
  changes: RuleChange[];
  conflicts: number;
}

// What applying `rules` would change on the eligible rows (optionally only `ids`), keeping only the
// changes `keep` accepts.
function plan(rules: RuleVersion[], opts: { ids?: number[]; keep?: (row: RuleTx, rule: RuleVersion) => boolean } = {}): Plan {
  let rows = db.prepare(`SELECT ${TX_COLS} FROM transactions WHERE ${ELIGIBLE} ORDER BY date DESC, id DESC`).all() as RuleTx[];
  if (opts.ids) {
    const want = new Set(opts.ids);
    rows = rows.filter((r) => want.has(r.id));
  }
  const changes: RuleChange[] = [];
  let conflicts = 0;
  for (const row of rows) {
    const d = decide(row, rules);
    if (!d) continue;
    if ('conflict' in d) {
      conflicts++;
      continue;
    }
    const { rule } = d;
    if (opts.keep && !opts.keep(row, rule)) continue;
    if (row.category === rule.category && row.category_rule_id === rule.rule_id && row.category_rule_version === rule.version) continue;
    changes.push({
      id: row.id, date: row.date, description: row.description, account: row.account, amount: row.amount,
      currency: row.currency, from: row.category || null, to: rule.category, rule_id: rule.rule_id, version: rule.version,
    });
  }
  return { changes, conflicts };
}

function applyChanges(changes: RuleChange[]): number {
  const upd = db.prepare(
    `UPDATE transactions SET category=?, category_source='rule', category_rule_id=?, category_rule_version=?, category_skipped=0 WHERE id=?`
  );
  db.transaction(() => {
    for (const c of changes) upd.run(c.to, c.rule_id, c.version, c.id);
  })();
  return changes.length;
}

// "Apply rules now", and the step after an import (`ids` = the new rows).
export function applyRules(ids?: number[]): { changed: number; conflicts: number } {
  const p = plan(activeRules(), { ids });
  return { changed: applyChanges(p.changes), conflicts: p.conflicts };
}

// ---------- the rule store ----------

export class RuleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new RuleError('Amounts must be zero or more');
  return n;
};

// Validates a draft from a request body and returns it normalised. Throws RuleError.
export function parseDraft(body: any): RuleDraft {
  const match = body?.match;
  if (match !== 'exact' && match !== 'contains') throw new RuleError('match must be "exact" or "contains"');
  const text = normalise(String(body?.text ?? ''));
  if (!text) throw new RuleError('Enter the text to match');
  if (text.length > 200) throw new RuleError('The text to match is longer than 200 characters');
  const type = body?.type;
  if (type !== 'Income' && type !== 'Expense') throw new RuleError('type must be "Income" or "Expense"');
  const account = body?.account ? String(body.account) : null;
  if (account && !db.prepare('SELECT 1 FROM accounts WHERE name=?').get(account)) throw new RuleError(`No account called "${account}"`);
  const amount_min = num(body?.amount_min);
  const amount_max = num(body?.amount_max);
  if (amount_min != null && amount_max != null && amount_min > amount_max) throw new RuleError('The minimum amount is more than the maximum');
  const category = String(body?.category ?? '');
  const cat = db.prepare('SELECT type FROM categories WHERE name=?').get(category) as { type: string } | undefined;
  if (!cat) throw new RuleError(`No category called "${category}"`);
  if (cat.type !== type) throw new RuleError(`"${category}" is a ${cat.type.toLowerCase()} category`);
  return { match, text, account, type, amount_min, amount_max, category };
}

const draftOf = (v: RuleDraft): RuleDraft => ({
  match: v.match, text: v.text, account: v.account, type: v.type, amount_min: v.amount_min, amount_max: v.amount_max, category: v.category,
});
const sameDraft = (a: RuleDraft, b: RuleDraft) => JSON.stringify(draftOf(a)) === JSON.stringify(draftOf(b));

function getRuleRow(id: number) {
  const r = db.prepare('SELECT * FROM rules WHERE id=?').get(id) as { id: number; current_version: number; status: string } | undefined;
  if (!r) throw new RuleError('Rule not found', 404);
  return r;
}

function getVersion(id: number, version: number): RuleVersion | undefined {
  return db.prepare('SELECT * FROM rule_versions WHERE rule_id=? AND version=?').get(id, version) as RuleVersion | undefined;
}

function audit(ruleId: number, version: number | null, action: string, before: unknown, after: unknown, actor = 'user') {
  db.prepare('INSERT INTO rule_audit (rule_id, version, action, actor, before_json, after_json) VALUES (?,?,?,?,?,?)')
    .run(ruleId, version, action, actor, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after));
}

function insertVersion(ruleId: number, version: number, d: RuleDraft, author: string) {
  db.prepare(
    `INSERT INTO rule_versions (rule_id, version, match, text, account, type, amount_min, amount_max, category, author) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(ruleId, version, d.match, d.text, d.account, d.type, d.amount_min, d.amount_max, d.category, author);
  return getVersion(ruleId, version)!;
}

// The rule set with `candidate` in place of its rule's current version (or added, for a new rule).
function withCandidate(candidate: RuleVersion): RuleVersion[] {
  return [...activeRules().filter((r) => r.rule_id !== candidate.rule_id), candidate];
}

// Saving a rule changes the rows it now wins, and re-checks the rows it had set. A rollback only
// re-checks the rows that rule set.
function planFor(candidate: RuleVersion, scope: 'save' | 'rollback'): Plan {
  const id = candidate.rule_id;
  return plan(withCandidate(candidate), {
    keep: scope === 'save'
      ? (row, rule) => rule.rule_id === id || row.category_rule_id === id
      : (row) => row.category_rule_id === id,
  });
}

const PREVIEW_ROWS = 50;
const previewOf = (p: Plan) => ({ count: p.changes.length, conflicts: p.conflicts, rows: p.changes.slice(0, PREVIEW_ROWS) });

// How many rows saving `draft` (as a new rule, or as a new version of rule `id`) would change.
export function previewSave(id: number | null, draft: RuleDraft) {
  const nextVersion = id == null ? 1 : getRuleRow(id).current_version + 1;
  const candidate: RuleVersion = { ...draft, rule_id: id ?? -1, version: nextVersion, author: 'user', created_at: '' };
  return previewOf(planFor(candidate, 'save'));
}

export function createRule(draft: RuleDraft, author = 'user') {
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO rules (current_version, status) VALUES (1, ?)').run('active').lastInsertRowid);
    const v = insertVersion(id, 1, draft, author);
    audit(id, 1, 'create', null, v, author);
    const applied = applyChanges(planFor(v, 'save').changes);
    return { id, applied };
  })();
}

export function editRule(id: number, draft: RuleDraft, actor = 'user') {
  return db.transaction(() => {
    const r = getRuleRow(id);
    const before = getVersion(id, r.current_version)!;
    if (sameDraft(before, draft) && r.status === 'active') throw new RuleError('Nothing changed');
    const v = insertVersion(id, r.current_version + 1, draft, actor);
    db.prepare("UPDATE rules SET current_version=?, status='active' WHERE id=?").run(v.version, id);
    audit(id, v.version, 'edit', before, v, actor);
    const applied = applyChanges(planFor(v, 'save').changes);
    return { id, applied };
  })();
}

// Retiring stops the rule. Rows it already categorised keep their category.
export function retireRule(id: number) {
  return db.transaction(() => {
    const r = getRuleRow(id);
    if (r.status === 'retired') throw new RuleError('This rule is already retired');
    db.prepare("UPDATE rules SET status='retired' WHERE id=?").run(id);
    audit(id, r.current_version, 'retire', { status: r.status }, { status: 'retired' });
    return { id };
  })();
}

function rollbackCandidate(id: number, toVersion: number): { candidate: RuleVersion; source: RuleVersion; current: RuleVersion } {
  const r = getRuleRow(id);
  const source = getVersion(id, toVersion);
  if (!source) throw new RuleError(`Version ${toVersion} not found`, 404);
  if (toVersion === r.current_version) throw new RuleError('That is already the current version');
  const current = getVersion(id, r.current_version)!;
  return { candidate: { ...draftOf(source), rule_id: id, version: r.current_version + 1, author: 'user', created_at: '' }, source, current };
}

export function previewRollback(id: number, toVersion: number) {
  return previewOf(planFor(rollbackCandidate(id, toVersion).candidate, 'rollback'));
}

// Writes a new version that copies `toVersion` (history stays complete), makes the rule active again
// and re-applies it to the rows it had set.
export function rollbackRule(id: number, toVersion: number) {
  return db.transaction(() => {
    const { source, current } = rollbackCandidate(id, toVersion);
    const v = insertVersion(id, current.version + 1, draftOf(source), 'user');
    db.prepare("UPDATE rules SET current_version=?, status='active' WHERE id=?").run(v.version, id);
    audit(id, v.version, 'rollback', current, { ...v, rolled_back_to: toVersion });
    const applied = applyChanges(planFor(v, 'rollback').changes);
    return { id, applied };
  })();
}

// A renamed category: each rule that uses it gets a new version with the new name.
export function renameCategoryInRules(oldName: string, newName: string) {
  if (oldName === newName) return;
  const using = db.prepare(`${versionSql} WHERE v.category = ?`).all(oldName) as RuleVersion[];
  for (const cur of using) {
    const v = insertVersion(cur.rule_id, cur.version + 1, { ...draftOf(cur), category: newName }, 'user');
    db.prepare('UPDATE rules SET current_version=? WHERE id=?').run(v.version, cur.rule_id);
    audit(cur.rule_id, v.version, 'edit', cur, v, 'category-rename');
  }
}

export function listRules() {
  return db
    .prepare(
      `SELECT v.*, r.status, r.current_version, r.created_at AS rule_created_at,
              (SELECT COUNT(*) FROM transactions t WHERE t.category_rule_id = r.id AND t.category_source = 'rule') AS row_count
         FROM rules r JOIN rule_versions v ON v.rule_id = r.id AND v.version = r.current_version
        ORDER BY r.status, v.text`
    )
    .all();
}

export function getRule(id: number) {
  const r = getRuleRow(id);
  return {
    ...r,
    versions: db.prepare('SELECT * FROM rule_versions WHERE rule_id=? ORDER BY version DESC').all(id),
    audit: db.prepare('SELECT * FROM rule_audit WHERE rule_id=? ORDER BY id DESC').all(id),
  };
}
