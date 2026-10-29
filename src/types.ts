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
