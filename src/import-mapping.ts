// Guesses which import role each CSV column plays, from its header (and, for a few roles, its values).

// Column keys: header text when present, positional otherwise.
export function columnKeys(rows: string[][], hasHeader: boolean): string[] {
  if (!rows.length) return [];
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
  return Array.from({ length: width }, (_, i) =>
    hasHeader ? String(rows[0][i] ?? `Column ${i + 1}`).trim() || `Column ${i + 1}` : `__col_${i}`
  );
}

interface Rule {
  role: string;
  // Exact header names, best first.
  exact: string[];
  // Looser match, ranked below every exact name.
  include?: RegExp;
  exclude?: RegExp;
}

// Roles are filled in this order; each takes its best column that is still free.
const RULES: Rule[] = [
  {
    role: 'date',
    exact: ['date', 'transaction date', 'booking date', 'posting date', 'posted date', 'completed date', 'value date'],
    include: /\bdate\b/,
    exclude: /\b(birth|due|created|updated|expiry)\b/,
  },
  {
    role: 'amount',
    exact: ['amount', 'transaction amount', 'value'],
    include: /\bamount\b/,
    exclude: /\b(balance|fee|fees|exchange|original|local|running|total|source|target)\b/,
  },
  {
    role: 'debit',
    exact: ['debit', 'debit amount', 'paid out', 'money out', 'withdrawal', 'withdrawals', 'out'],
    include: /\b(debit|paid out|money out|withdrawals?)\b/,
    exclude: /\b(card|type|balance)\b/,
  },
  {
    role: 'credit',
    exact: ['credit', 'credit amount', 'paid in', 'money in', 'deposit', 'deposits', 'in'],
    include: /\b(credit|paid in|money in|deposits?)\b/,
    exclude: /\b(card|type|balance|limit)\b/,
  },
  {
    role: 'description',
    exact: [
      'description', 'transaction description', 'details', 'narrative', 'memo', 'merchant', 'payee',
      'counter party', 'counterparty', 'name', 'reference',
    ],
    include: /\b(description|details|narrative)\b/,
    exclude: /\btype\b/,
  },
  {
    role: 'currency',
    exact: ['currency', 'ccy', 'currency code', 'transaction currency'],
    include: /\b(currency|ccy)\b/,
    exclude: /\b(local|exchange|original|source|target)\b/,
  },
  {
    role: 'type',
    exact: ['type', 'transaction type', 'debit credit', 'credit debit', 'dr cr', 'cr dr', 'direction'],
    include: /\btype\b/,
    exclude: /\b(details|card|account|currency)\b/,
  },
  { role: 'account', exact: ['account', 'account name'] },
  { role: 'category', exact: ['category', 'categories', 'spending category'], include: /\bcategor/, exclude: /\bsplit\b/ },
  { role: 'notes', exact: ['notes', 'note', 'memo', 'comment', 'comments'], include: /\b(notes?|comments?)\b/ },
];

const normalize = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A Type column is only useful when its values say income or expense (DEBIT/CREDIT, IN/OUT...).
// Values like "Card payment" or "TRANSFER" would override the amount's sign with a guess.
const TYPE_VALUE = /^(debit|credit|dr|cr|in|out|income|expense|money in|money out|paid in|paid out|deposit|withdrawal)$/;

export interface GuessContext {
  // Data rows (no header), to check the values of Type, Account and Category columns.
  rows?: string[][];
  accounts?: string[];
  categories?: string[];
}

function sampleValues(rows: string[][], col: number): string[] {
  return rows
    .slice(0, 50)
    .map((r) => String(r[col] ?? '').trim().toLowerCase())
    .filter((v) => v !== '');
}

// Columns whose values would be wrong for the role, even though the header fits.
function valuesFit(role: string, col: number, ctx: GuessContext): boolean {
  if (role !== 'type' && role !== 'account' && role !== 'category') return true;
  const values = sampleValues(ctx.rows ?? [], col);
  if (!values.length) return false;
  if (role === 'type') return values.every((v) => TYPE_VALUE.test(v));
  // Bank exports often carry account numbers or their own category names; only map a column
  // whose values are accounts / categories that already exist here.
  const known = new Set((role === 'account' ? ctx.accounts : ctx.categories)?.map((n) => n.trim().toLowerCase()));
  const hits = values.filter((v) => known.has(v)).length;
  return role === 'account' ? hits === values.length : hits * 2 >= values.length;
}

function score(rule: Rule, header: string): number {
  const exactAt = rule.exact.indexOf(header);
  if (exactAt >= 0) return 1000 - exactAt;
  if (rule.include?.test(header) && !rule.exclude?.test(header)) return 1;
  return 0;
}

// Returns { columnKey: role } for the columns it is fairly sure about. Headerless files get nothing.
export function guessMapping(headers: string[], ctx: GuessContext = {}): Record<string, string> {
  const names = headers.map(normalize);
  const taken = new Set<number>();
  const mapping: Record<string, string> = {};
  for (const rule of RULES) {
    // A signed amount column already covers money in and out.
    if ((rule.role === 'debit' || rule.role === 'credit') && Object.values(mapping).includes('amount')) continue;
    let best = -1;
    let bestScore = 0;
    names.forEach((name, i) => {
      if (taken.has(i) || Object.hasOwn(mapping, headers[i])) return;
      const s = score(rule, name);
      if (s > bestScore && valuesFit(rule.role, i, ctx)) {
        best = i;
        bestScore = s;
      }
    });
    if (best >= 0) {
      taken.add(best);
      mapping[headers[best]] = rule.role;
    }
  }
  // Money in without money out (or the reverse) can't be imported on its own terms.
  const roles = Object.values(mapping);
  if (roles.includes('debit') !== roles.includes('credit')) {
    for (const [k, v] of Object.entries(mapping)) if (v === 'debit' || v === 'credit') delete mapping[k];
  }
  return mapping;
}
