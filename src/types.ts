export interface Tx {
  id: number;
  date: string;
  description: string;
  account: string;
  category: string | null;
  amount: number;
  currency: string;
  fx_rate: number | null;
  amount_czk: number | null;
  type: 'Expense' | 'Income' | 'Transfer';
  entity: string | null;
  notes: string | null;
  recurring: number;
  necessity: Necessity | null;
  category_source: 'user' | 'rule' | 'llm' | 'import' | null;
  category_rule_id: number | null;
  category_rule_version: number | null;
}

export type Necessity = 'need' | 'want';

export interface Account {
  id: number;
  name: string;
  type: string;
  entity: string | null;
  base_currency: string;
  opening_balance: number;
}

export interface Category {
  id: number;
  name: string;
  type: string;
  grp: string;
}

export interface RecurringItem {
  id: number;
  description: string;
  amount: number | null;
  currency: string | null;
  account: string | null;
  category: string | null;
  frequency: string | null;
  last_seen: string | null;
  next_expected: string | null;
  active: number;
  occurrences: number;
  previous_amount: number | null;
  price_changed_on: string | null;
}

export interface MonthlyRow {
  month: string;
  income: number;
  expenses: number;
  net: number;
  savingsRate: number;
  topCategory: string | null;
  topCategoryAmount: number;
  avgDailySpend: number;
}

// One version of a category rule (#3488). `text` is normalised (lower case, single spaces).
export interface RuleDraft {
  match: 'exact' | 'contains';
  text: string;
  account: string | null;
  type: 'Income' | 'Expense';
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

export interface RuleListItem extends RuleVersion {
  status: 'active' | 'retired';
  current_version: number;
  row_count: number;
}

export interface RuleAudit {
  id: number;
  rule_id: number;
  version: number | null;
  action: string;
  actor: string;
  at: string;
  before_json: string | null;
  after_json: string | null;
}

export interface RulePreview {
  count: number;
  conflicts: number;
  rows: { id: number; date: string; description: string; account: string; amount: number; currency: string; from: string | null; to: string }[];
}

// A suggestion in the Inbox (#3489). Payload text may come from bank descriptions: plain text only.
export interface Suggestion {
  id: number;
  kind: string;
  payload: any;
  status: 'pending' | 'accepted' | 'rejected' | 'edited' | 'expired';
  created_at: string;
  decided_at: string | null;
  model: string | null;
  prompt_version: string | null;
  run_id: string | null;
}

export interface ImportTemplate {
  id: number;
  name: string;
  config: TemplateConfig;
}

export interface TemplateConfig {
  // header name -> role; '__col_N' keys used when the file has no header row
  mapping: Record<string, string>;
  hasHeader: boolean;
  dateFormat: 'auto' | 'DMY' | 'MDY' | 'YMD';
  amountMode: 'signed' | 'inverted' | 'debit_credit';
  defaultAccount: string;
  defaultCurrency: string;
  defaultType: 'Expense' | 'Income';
  defaultCategory: string | null;
}

export const COLUMN_ROLES = [
  { value: '', label: '— Ignore —' },
  { value: 'date', label: 'Date' },
  { value: 'description', label: 'Description' },
  { value: 'amount', label: 'Amount (signed)' },
  { value: 'debit', label: 'Debit (money out)' },
  { value: 'credit', label: 'Credit (money in)' },
  { value: 'currency', label: 'Currency' },
  { value: 'category', label: 'Category' },
  { value: 'account', label: 'Account' },
  { value: 'type', label: 'Type (Income/Expense)' },
  { value: 'notes', label: 'Notes' },
] as const;

export const CURRENCIES = ['CZK', 'EUR', 'GBP', 'USD', 'PLN', 'CHF', 'SEK', 'NOK', 'DKK', 'HUF'];
