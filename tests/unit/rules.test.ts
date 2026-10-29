import { beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';
import { decide, normalise, type RuleVersion } from '../../server/rules';

const api = startApi();

const rule = (over: Partial<RuleVersion>): RuleVersion => ({
  rule_id: 1, version: 1, match: 'contains', text: 'albert', account: null, type: 'Expense',
  amount_min: null, amount_max: null, category: 'Groceries', author: 'user', created_at: '', ...over,
});
const tx = (description: string, over: Record<string, unknown> = {}) =>
  ({ description, account: 'Current', type: 'Expense', amount: -100, ...over });

describe('rule matching (pure)', () => {
  it('normalises case beyond ASCII and whitespace', () => {
    expect(normalise('  ŽABKA   Praha ')).toBe('žabka praha');
  });

  it('exact beats contains, longer text beats shorter, account-specific beats general', () => {
    const contains = rule({ rule_id: 1, text: 'albert', category: 'Groceries' });
    const exact = rule({ rule_id: 2, match: 'exact', text: 'albert lekarna', category: 'Health' });
    const longer = rule({ rule_id: 3, text: 'albert lek', category: 'Pharmacy' });
    const onAccount = rule({ rule_id: 4, text: 'albert', account: 'Business', category: 'Office' });

    expect(decide(tx('ALBERT  Lekarna'), [contains, exact, longer])).toEqual({ rule: exact });
    expect(decide(tx('Albert lekarna 2'), [contains, exact, longer])).toEqual({ rule: longer });
    expect(decide(tx('Albert'), [contains, onAccount])).toEqual({ rule: contains });
    expect(decide(tx('Albert', { account: 'Business' }), [contains, onAccount])).toEqual({ rule: onAccount });
  });

  it('two equally specific rules with different categories are a conflict; the same category is not', () => {
    const a = rule({ rule_id: 1, text: 'albert', category: 'Groceries' });
    const b = rule({ rule_id: 2, text: 'albert', category: 'Eating out' });
    const c = rule({ rule_id: 3, text: 'albert', category: 'Groceries' });
    expect(decide(tx('Albert'), [a, b])).toEqual({ conflict: [a, b] });
    expect(decide(tx('Albert'), [c, a])).toEqual({ rule: a }); // lowest id
  });

  it('checks type and the size of the amount', () => {
    const r = rule({ amount_min: 100, amount_max: 500 });
    expect(decide(tx('Albert', { amount: -100 }), [r])).not.toBeNull();
    expect(decide(tx('Albert', { amount: -501 }), [r])).toBeNull();
    expect(decide(tx('Albert', { amount: -99 }), [r])).toBeNull();
    expect(decide(tx('Albert', { type: 'Income', amount: 200 }), [r])).toBeNull();
  });
});

// Made-up CZK rows, so nothing needs an FX rate.
const ids: Record<string, number> = {};
const draft = (over: Record<string, unknown> = {}) => ({
  match: 'contains', text: 'albert', account: null, type: 'Expense', amount_min: null, amount_max: null, category: 'Groceries', ...over,
});
const row = async (key: string) => (await api.get(`/api/transactions?search=${encodeURIComponent(key)}`)).body.rows[0];
const byId = async (id: number) =>
  ((await api.get('/api/transactions?limit=500')).body.rows as any[]).find((r) => r.id === id);

beforeAll(async () => {
  await api.post('/api/accounts', { name: 'Current', type: 'Personal', base_currency: 'CZK' });
  await api.post('/api/accounts', { name: 'Business', type: 'Business', base_currency: 'CZK' });
  for (const [name, type] of [['Groceries', 'Expense'], ['Eating out', 'Expense'], ['Health', 'Expense'], ['Salary', 'Income']]) {
    await api.post('/api/categories', { name, type, grp: 'Other' });
  }
  const add = async (key: string, t: Record<string, unknown>) => {
    ids[key] = (await api.post('/api/transactions', { account: 'Current', currency: 'CZK', type: 'Expense', ...t })).body.id;
  };
  await add('a1', { date: '2026-05-01', description: 'ALBERT Praha', amount: -500 });
  await add('a2', { date: '2026-05-02', description: 'Albert', amount: -90 });
  await add('mine', { date: '2026-05-03', description: 'Albert', amount: -70, category: 'Eating out' });
  await add('lek', { date: '2026-05-04', description: 'Albert lékárna', amount: -300 });
  await add('pay', { date: '2026-05-25', description: 'Albert payroll', amount: 1000, type: 'Income' });
  await add('move', { date: '2026-05-26', description: 'Albert transfer', amount: -10, type: 'Transfer' });
});

describe('rules API', () => {
  it('refuses a bad draft', async () => {
    expect((await api.post('/api/rules/preview', { draft: draft({ category: 'Nope' }) })).status).toBe(400);
    expect((await api.post('/api/rules/preview', { draft: draft({ category: 'Salary' }) })).body.error).toMatch(/income category/);
    expect((await api.post('/api/rules/preview', { draft: draft({ text: '  ' }) })).status).toBe(400);
    expect((await api.post('/api/rules/preview', { draft: draft({ match: 'regex' }) })).status).toBe(400);
    expect((await api.post('/api/rules/preview', { draft: draft({ amount_min: 5, amount_max: 1 }) })).status).toBe(400);
    expect((await api.post('/api/rules/preview', { draft: draft({ account: 'Nowhere' }) })).status).toBe(400);
  });

  it('previews, then creates a rule that only fills rows without a user category', async () => {
    const preview = await api.post('/api/rules/preview', { draft: draft({ text: ' ALBERT ' }) });
    expect(preview.status).toBe(200);
    // a1, a2 and the pharmacy row; not the user's row, not income, not the transfer.
    expect(preview.body.count).toBe(3);
    expect(preview.body.rows.map((r: any) => r.description)).toEqual(['Albert lékárna', 'Albert', 'ALBERT Praha']);
    expect(preview.body.rows[0]).toMatchObject({ from: null, to: 'Groceries' });

    const created = await api.post('/api/rules', { draft: draft({ text: ' ALBERT ' }) });
    expect(created.body).toMatchObject({ applied: 3 });
    ids.rule = created.body.id;
    expect(await byId(ids.a1)).toMatchObject({
      category: 'Groceries', category_source: 'rule', category_rule_id: ids.rule, category_rule_version: 1,
    });
    expect(await byId(ids.mine)).toMatchObject({ category: 'Eating out', category_source: 'user', category_rule_id: null });
    expect((await byId(ids.pay)).category).toBeNull();
    expect((await byId(ids.move)).category).toBeNull();

    const list = (await api.get('/api/rules')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ rule_id: ids.rule, text: 'albert', version: 1, status: 'active', row_count: 3 });
  });

  it('a more specific rule takes over the rows it matches; an equal one with another category conflicts', async () => {
    const health = await api.post('/api/rules', { draft: draft({ match: 'exact', text: 'albert lékárna', category: 'Health' }) });
    expect(health.body.applied).toBe(1);
    ids.health = health.body.id;
    expect(await byId(ids.lek)).toMatchObject({ category: 'Health', category_rule_id: ids.health });

    // Same rank as the first rule, different category: no row changes, and "Apply" counts conflicts.
    const rival = await api.post('/api/rules/preview', { draft: draft({ category: 'Eating out' }) });
    expect(rival.body).toMatchObject({ count: 0, conflicts: 2 });
  });

  it('a category the user picks is never changed by a rule again', async () => {
    await api.put(`/api/transactions/${ids.a2}/category`, { category: 'Eating out' });
    expect(await byId(ids.a2)).toMatchObject({ category: 'Eating out', category_source: 'user', category_rule_id: null });
    expect((await api.post('/api/rules/apply')).body.changed).toBe(0);
    expect((await byId(ids.a2)).category).toBe('Eating out');

    // Clearing it makes the row fair game for the rules again.
    await api.put(`/api/transactions/${ids.a2}/category`, { category: null });
    expect((await byId(ids.a2)).category_source).toBeNull();
    expect((await api.post('/api/rules/apply')).body).toMatchObject({ changed: 1, conflicts: 0 });
    expect(await byId(ids.a2)).toMatchObject({ category: 'Groceries', category_source: 'rule' });

    // The full editor counts as the user's choice too, but only when the category changes.
    const t = await byId(ids.a1);
    await api.put(`/api/transactions/${ids.a1}`, { ...t, notes: 'checked' });
    expect((await byId(ids.a1)).category_source).toBe('rule');
    await api.put(`/api/transactions/${ids.a1}`, { ...t, category: 'Health' });
    expect(await byId(ids.a1)).toMatchObject({ category: 'Health', category_source: 'user', category_rule_id: null });
  });

  it('an edit writes a new version and re-categorises the rows the rule set', async () => {
    const preview = await api.post('/api/rules/preview', { id: ids.rule, draft: draft({ category: 'Eating out' }) });
    expect(preview.body.count).toBe(1); // a2 (a1 is the user's now, the pharmacy row is the Health rule's)
    const edited = await api.put(`/api/rules/${ids.rule}`, { draft: draft({ category: 'Eating out' }) });
    expect(edited.body.applied).toBe(1);
    expect(await byId(ids.a2)).toMatchObject({ category: 'Eating out', category_rule_version: 2 });
    expect((await api.put(`/api/rules/${ids.rule}`, { draft: draft({ category: 'Eating out' }) })).body.error).toBe('Nothing changed');
  });

  it('a rollback copies the old version into a new one and re-applies it only to rows the rule set', async () => {
    // A row the rule never set: uncategorised and not matched before (the rule matches it now, but a
    // rollback only re-checks the rule's own rows).
    await api.post('/api/transactions', { date: '2026-05-05', description: 'Albert new', account: 'Current', amount: -20, currency: 'CZK', type: 'Expense' });
    const preview = await api.post(`/api/rules/${ids.rule}/rollback/preview`, { version: 1 });
    expect(preview.body.count).toBe(1);
    const rolled = await api.post(`/api/rules/${ids.rule}/rollback`, { version: 1 });
    expect(rolled.body.applied).toBe(1);
    expect(await byId(ids.a2)).toMatchObject({ category: 'Groceries', category_rule_version: 3 });
    expect((await row('Albert new')).category).toBeNull();

    const detail = (await api.get(`/api/rules/${ids.rule}`)).body;
    expect(detail.current_version).toBe(3);
    expect(detail.versions.map((v: any) => [v.version, v.category])).toEqual([[3, 'Groceries'], [2, 'Eating out'], [1, 'Groceries']]);
    expect(detail.audit.map((a: any) => a.action)).toEqual(['rollback', 'edit', 'create']);
    const last = detail.audit[0];
    expect(JSON.parse(last.before_json)).toMatchObject({ version: 2, category: 'Eating out' });
    expect(JSON.parse(last.after_json)).toMatchObject({ version: 3, category: 'Groceries', rolled_back_to: 1 });
    expect((await api.post(`/api/rules/${ids.rule}/rollback`, { version: 3 })).status).toBe(400);
    expect((await api.post(`/api/rules/${ids.rule}/rollback`, { version: 9 })).status).toBe(404);
  });

  it('versions are append-only', async () => {
    const { db } = await import('../../server/db');
    expect(() => db.prepare("UPDATE rule_versions SET category='Health'").run()).toThrow(/append-only/);
  });

  it('a retired rule stops but keeps the rows it set; a rollback brings it back', async () => {
    expect((await api.post(`/api/rules/${ids.rule}/retire`)).status).toBe(200);
    expect((await api.post(`/api/rules/${ids.rule}/retire`)).status).toBe(400);
    expect((await byId(ids.a2)).category).toBe('Groceries');
    expect((await api.post('/api/rules/apply')).body.changed).toBe(0);
    expect((await row('Albert new')).category).toBeNull();
    const list = (await api.get('/api/rules')).body;
    expect(list.find((r: any) => r.rule_id === ids.rule).status).toBe('retired');
  });

  it('a category rename gives the rules that use it a new version', async () => {
    const cats = (await api.get('/api/categories')).body as any[];
    const health = cats.find((c) => c.name === 'Health');
    await api.put(`/api/categories/${health.id}`, { ...health, name: 'Pharmacy' });
    const detail = (await api.get(`/api/rules/${ids.health}`)).body;
    expect(detail.versions[0]).toMatchObject({ version: 2, category: 'Pharmacy' });
    expect(detail.audit[0]).toMatchObject({ action: 'edit', actor: 'category-rename' });
    expect(await byId(ids.lek)).toMatchObject({ category: 'Pharmacy' });
  });

  it('runs on import: new rows without a category get one, a category from the file stays', async () => {
    const res = await api.post('/api/import', {
      rows: [
        { date: '2026-06-01', description: 'Albert lékárna', account: 'Current', amount: -150, currency: 'CZK', type: 'Expense' },
        { date: '2026-06-02', description: 'Albert lékárna', account: 'Current', amount: -160, currency: 'CZK', type: 'Expense', category: 'Groceries' },
        { date: '2026-06-03', description: 'Shell', account: 'Current', amount: -900, currency: 'CZK', type: 'Expense' },
      ],
    });
    expect(res.body).toMatchObject({ inserted: 3, categorised: 1 });
    const rows = (await api.get('/api/transactions?month=2026-06')).body.rows as any[];
    const by = (d: string) => rows.find((r) => r.date === d);
    expect(by('2026-06-01')).toMatchObject({ category: 'Pharmacy', category_source: 'rule', category_rule_id: ids.health });
    expect(by('2026-06-02')).toMatchObject({ category: 'Groceries', category_source: 'import' });
    expect(by('2026-06-03')).toMatchObject({ category: null, category_source: null });
  });
});
