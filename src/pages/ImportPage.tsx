import { useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { czk, num } from '../format';
import { Account, Category, ImportTemplate, TemplateConfig, COLUMN_ROLES, CURRENCIES } from '../types';
import { Toast, TypeBadge, useToast } from '../components/ui';

// ---------- parsing helpers ----------

const CCY_SYMBOLS: Record<string, string> = { '£': 'GBP', '€': 'EUR', '$': 'USD', 'Kč': 'CZK', 'zł': 'PLN' };

function normalizeCurrency(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const s = raw.trim();
  for (const [sym, code] of Object.entries(CCY_SYMBOLS)) if (s.includes(sym)) return code;
  const m = s.toUpperCase().match(/[A-Z]{3}/);
  return m ? m[0] : fallback;
}

export function parseAmount(raw: string | number | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  let s = raw.trim();
  if (!s) return null;
  const negParen = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '').replace(/[^\d.,\-+]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Whichever separator comes last is the decimal point
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // Comma only: decimal if followed by 1-2 digits, else thousands sep
    const after = s.length - lastComma - 1;
    s = after > 0 && after <= 2 ? s.replace(/,/g, '.') : s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return negParen ? -n : n;
}

export function parseDate(raw: string | undefined, mode: 'auto' | 'DMY' | 'MDY' | 'YMD'): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = `20${y}`;
    let day: string, mon: string;
    if (mode === 'MDY') { mon = a; day = b; }
    else if (mode === 'DMY' || mode === 'YMD') { day = a; mon = b; }
    else {
      // auto: disambiguate when possible, default to day-first (UK/EU)
      if (+a > 12) { day = a; mon = b; }
      else if (+b > 12) { mon = a; day = b; }
      else { day = a; mon = b; }
    }
    if (+mon < 1 || +mon > 12 || +day < 1 || +day > 31) return null;
    return `${y}-${mon.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  // Text dates like "12 Mar 2026"
  const parsed = new Date(s);
  if (!isNaN(+parsed)) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  }
  return null;
}

interface NormRow {
  idx: number;
  date: string | null;
  description: string;
  amount: number | null;
  currency: string;
  category: string | null;
  account: string;
  type: string;
  notes: string | null;
  entity: string | null;
  error: string | null;
  duplicate?: boolean;
  duplicateInBatch?: boolean;
  include: boolean;
}

const defaultConfig = (): TemplateConfig => ({
  mapping: {},
  hasHeader: true,
  dateFormat: 'auto',
  amountMode: 'signed',
  defaultAccount: '',
  defaultCurrency: 'CZK',
  defaultType: 'Expense',
  defaultCategory: null,
});

export default function ImportPage() {
  const [step, setStep] = useState(0);
  const [fileName, setFileName] = useState('');
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [config, setConfig] = useState<TemplateConfig>(defaultConfig());
  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [normRows, setNormRows] = useState<NormRow[]>([]);
  const [skipDups, setSkipDups] = useState(true);
  const [result, setResult] = useState<any | null>(null);
  const [tplName, setTplName] = useState('');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [toast, showToast] = useToast();

  useEffect(() => {
    api.get<ImportTemplate[]>('/api/import-templates').then(setTemplates);
    api.get<Account[]>('/api/accounts').then(setAccounts);
    api.get<Category[]>('/api/categories').then(setCategories);
  }, []);

  // ----- step 0: file -----
  const handleFile = (file: File) => {
    Papa.parse(file, {
      skipEmptyLines: 'greedy',
      complete: (res) => {
        const rows = (res.data as string[][]).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
        if (!rows.length) { showToast('File appears to be empty'); return; }
        setRawRows(rows);
        setFileName(file.name);
        setConfig(defaultConfig());
        setResult(null);
        setStep(1);
      },
      error: (e) => showToast(`Parse error: ${e.message}`),
    });
  };

  // Column keys: header text when present, positional otherwise
  const colKeys = useMemo(() => {
    if (!rawRows.length) return [];
    const width = Math.max(...rawRows.slice(0, 50).map((r) => r.length));
    return Array.from({ length: width }, (_, i) =>
      config.hasHeader ? String(rawRows[0][i] ?? `Column ${i + 1}`).trim() || `Column ${i + 1}` : `__col_${i}`
    );
  }, [rawRows, config.hasHeader]);

  const dataRows = useMemo(() => (config.hasHeader ? rawRows.slice(1) : rawRows), [rawRows, config.hasHeader]);

  const colLabel = (key: string, i: number) => (config.hasHeader ? key : `Column ${i + 1}`);

  const setMapping = (key: string, role: string) => {
    const mapping = { ...config.mapping };
    // A role can only be assigned to one column
    for (const k of Object.keys(mapping)) if (mapping[k] === role && role !== '') delete mapping[k];
    if (role === '') delete mapping[key];
    else mapping[key] = role;
    setConfig({ ...config, mapping });
  };

  const roleOf = (key: string) => config.mapping[key] ?? '';
  const roleAssigned = (role: string) => Object.values(config.mapping).includes(role);

  const applyTemplate = (t: ImportTemplate) => {
    const c = t.config;
    // Keep only mapping entries whose column exists in this file
    const mapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.mapping)) if (colKeys.includes(k)) mapping[k] = v;
    setConfig({ ...c, mapping });
    setTplName(t.name);
    showToast(`Template "${t.name}" applied (${Object.keys(mapping).length} of ${Object.keys(c.mapping).length} columns matched)`);
  };

  const saveTemplate = async () => {
    if (!tplName.trim()) { showToast('Give the template a name first'); return; }
    await api.post('/api/import-templates', { name: tplName.trim(), config });
    api.get<ImportTemplate[]>('/api/import-templates').then(setTemplates);
    showToast(`Template "${tplName.trim()}" saved`);
  };

  const deleteTemplate = async (t: ImportTemplate) => {
    if (!confirm(`Delete template "${t.name}"?`)) return;
    await api.del(`/api/import-templates/${t.id}`);
    api.get<ImportTemplate[]>('/api/import-templates').then(setTemplates);
  };

  // ----- step 1 -> 2: normalize + duplicate check -----
  const mappingValid =
    roleAssigned('date') &&
    (roleAssigned('amount') || roleAssigned('debit') || roleAssigned('credit')) &&
    (roleAssigned('account') || config.defaultAccount);

  const buildPreview = async () => {
    const colIdx: Record<string, number> = {};
    colKeys.forEach((k, i) => { if (config.mapping[k]) colIdx[config.mapping[k]] = i; });
    const accByName = new Map(accounts.map((a) => [a.name.toLowerCase(), a]));

    const rows: NormRow[] = dataRows.map((r, idx) => {
      const cell = (role: string) => (colIdx[role] != null ? String(r[colIdx[role]] ?? '').trim() : '');
      const date = parseDate(cell('date'), config.dateFormat);
      let amount: number | null = null;
      let type: string = config.defaultType;

      if (colIdx['debit'] != null || colIdx['credit'] != null) {
        const debit = parseAmount(cell('debit'));
        const credit = parseAmount(cell('credit'));
        if (debit != null && debit !== 0) { amount = Math.abs(debit); type = 'Expense'; }
        else if (credit != null && credit !== 0) { amount = Math.abs(credit); type = 'Income'; }
      } else {
        const signed = parseAmount(cell('amount'));
        if (signed != null) {
          const negIsExpense = config.amountMode !== 'inverted';
          type = (signed < 0) === negIsExpense ? 'Expense' : 'Income';
          amount = Math.abs(signed);
        }
      }

      // Explicit type column wins over the sign convention
      const rawType = cell('type').toLowerCase();
      if (rawType) {
        if (/(income|credit|in|deposit|received)/.test(rawType)) type = 'Income';
        else if (/(expense|debit|out|payment|purchase|card)/.test(rawType)) type = 'Expense';
        else if (/transfer/.test(rawType)) type = 'Transfer';
      }

      const accountName = cell('account') || config.defaultAccount;
      const acc = accByName.get(accountName.toLowerCase());
      const currency = normalizeCurrency(cell('currency'), acc?.base_currency ?? config.defaultCurrency);

      let error: string | null = null;
      if (!date) error = 'Unrecognized date';
      else if (amount == null || amount === 0) error = 'No amount';
      else if (!accountName) error = 'No account';

      return {
        idx,
        date,
        description: cell('description'),
        amount,
        currency,
        category: cell('category') || config.defaultCategory,
        account: acc?.name ?? accountName,
        type,
        notes: cell('notes') || null,
        entity: acc?.entity ?? null,
        error,
        include: !error,
      };
    });

    // Duplicate check against the database
    const valid = rows.filter((r) => !r.error);
    try {
      const flags = await api.post('/api/import/check', {
        rows: valid.map((r) => ({ date: r.date, account: r.account, amount: r.amount, description: r.description })),
      });
      valid.forEach((r, i) => {
        r.duplicate = flags[i].duplicate;
        r.duplicateInBatch = flags[i].duplicateInBatch;
      });
    } catch { /* dup check is advisory */ }
    setNormRows(rows);
    setStep(2);
  };

  // ----- step 2 -> 3: commit -----
  const doImport = async () => {
    const chosen = normRows.filter((r) => r.include && !r.error && (!skipDups || (!r.duplicate && !r.duplicateInBatch)));
    if (!chosen.length) { showToast('Nothing selected to import'); return; }
    setBusy(true);
    try {
      const res = await api.post('/api/import', {
        rows: chosen.map((r) => ({
          date: r.date, description: r.description, account: r.account, category: r.category,
          amount: r.amount, currency: r.currency, type: r.type, notes: r.notes, entity: r.entity,
        })),
      });
      setResult({ ...res, skippedDup: normRows.filter((r) => !r.error && skipDups && (r.duplicate || r.duplicateInBatch)).length, invalid: normRows.filter((r) => r.error).length });
      setStep(3);
    } catch (e: any) {
      showToast(`Import failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const stats = useMemo(() => {
    const valid = normRows.filter((r) => !r.error);
    return {
      total: normRows.length,
      invalid: normRows.length - valid.length,
      dups: valid.filter((r) => r.duplicate || r.duplicateInBatch).length,
      willImport: normRows.filter((r) => r.include && !r.error && (!skipDups || (!r.duplicate && !r.duplicateInBatch))).length,
    };
  }, [normRows, skipDups]);

  const steps = ['1 · Upload', '2 · Map columns', '3 · Preview', '4 · Done'];

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Import CSV</h2>
          <div className="sub">Bank/PayPal exports → mapped transactions, with reusable templates</div>
        </div>
      </div>

      <div className="import-steps">
        {steps.map((s, i) => (
          <span key={s} className={`step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}>{i < step ? '✓ ' : ''}{s}</span>
        ))}
      </div>

      {step === 0 && (
        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
        >
          <p style={{ fontSize: 16, margin: '0 0 6px' }}>Drop a CSV export here, or click to browse</p>
          <p className="small">Any bank's format works — you'll map the columns in the next step.</p>
          <input ref={fileInput} type="file" accept=".csv,.txt,.tsv" hidden onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
        </div>
      )}

      {step === 1 && (
        <>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{fileName} <span className="muted small">· {dataRows.length} rows</span></h3>
              {templates.length > 0 && (
                <div className="row">
                  <span className="muted small">Apply template:</span>
                  {templates.map((t) => (
                    <span key={t.id} className="row" style={{ gap: 2 }}>
                      <button className="small" onClick={() => applyTemplate(t)}>{t.name}</button>
                      <button className="small danger" title="Delete template" onClick={() => deleteTemplate(t)}>✕</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="filters mt16">
              <label className="fld">
                <span>First row is headers</span>
                <select value={config.hasHeader ? 'yes' : 'no'} onChange={(e) => setConfig({ ...config, hasHeader: e.target.value === 'yes', mapping: {} })}>
                  <option value="yes">Yes</option><option value="no">No</option>
                </select>
              </label>
              <label className="fld">Date format
                <select value={config.dateFormat} onChange={(e) => setConfig({ ...config, dateFormat: e.target.value as any })}>
                  <option value="auto">Auto (day-first if ambiguous)</option>
                  <option value="DMY">DD/MM/YYYY</option>
                  <option value="MDY">MM/DD/YYYY</option>
                  <option value="YMD">YYYY/MM/DD</option>
                </select>
              </label>
              <label className="fld">Amount sign
                <select value={config.amountMode} onChange={(e) => setConfig({ ...config, amountMode: e.target.value as any })}>
                  <option value="signed">Negative = expense</option>
                  <option value="inverted">Negative = income</option>
                </select>
              </label>
              <label className="fld">Default account {roleAssigned('account') ? <span className="muted">(fallback)</span> : <span style={{ color: 'var(--bad-text)' }}>*</span>}
                <select value={config.defaultAccount} onChange={(e) => setConfig({ ...config, defaultAccount: e.target.value })}>
                  <option value="">— select —</option>
                  {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
              </label>
              <label className="fld">Default currency
                <select value={config.defaultCurrency} onChange={(e) => setConfig({ ...config, defaultCurrency: e.target.value })}>
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label className="fld">Default category
                <select value={config.defaultCategory ?? ''} onChange={(e) => setConfig({ ...config, defaultCategory: e.target.value || null })}>
                  <option value="">— none —</option>
                  {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </label>
            </div>
          </div>

          <div className="card">
            <h3>Map each column <span className="muted small">(sample values from your file shown below each name)</span></h3>
            <div className="map-grid">
              {colKeys.map((key, i) => (
                <div key={i} className={`map-col ${roleOf(key) ? 'mapped' : ''}`}>
                  <div className="col-name">{colLabel(key, i)}</div>
                  <div className="col-sample">
                    {dataRows.slice(0, 3).map((r) => r[i]).filter(Boolean).join(' · ') || '—'}
                  </div>
                  <select value={roleOf(key)} onChange={(e) => setMapping(key, e.target.value)}>
                    {COLUMN_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
              ))}
            </div>
            {!mappingValid && (
              <div className="callout warn mt16">
                Required: a <b>Date</b> column, an <b>Amount</b> (or Debit/Credit) column, and an account (mapped column or default).
              </div>
            )}
            <div className="row mt16">
              <button onClick={() => setStep(0)}>← Back</button>
              <span className="spacer" />
              <input placeholder="Template name…" value={tplName} onChange={(e) => setTplName(e.target.value)} />
              <button onClick={saveTemplate}>Save as template</button>
              <button className="primary" disabled={!mappingValid} onClick={buildPreview}>Preview →</button>
            </div>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="card">
            <div className="row">
              <b>{stats.willImport}</b>&nbsp;of {stats.total} rows will be imported
              {stats.dups > 0 && <span className="badge warn">{stats.dups} duplicates</span>}
              {stats.invalid > 0 && <span className="badge expense">{stats.invalid} invalid (skipped)</span>}
              <span className="spacer" />
              <label className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={skipDups} onChange={(e) => setSkipDups(e.target.checked)} />
                Skip duplicates
              </label>
            </div>
            <div className="card-note">
              Duplicates = same date, account, amount and description as an existing transaction (or a repeat within this file).
              CZK conversion uses the daily rate for each transaction's date, fetched automatically on import.
            </div>
          </div>
          <div className="card">
            <div className="tbl-scroll" style={{ maxHeight: 480, overflowY: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th></th><th>Date</th><th>Description</th><th>Account</th><th>Category</th>
                    <th className="num">Amount</th><th>Type</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {normRows.map((r) => (
                    <tr key={r.idx} style={r.error || (skipDups && (r.duplicate || r.duplicateInBatch)) ? { opacity: 0.45 } : undefined}>
                      <td>
                        <input type="checkbox" checked={r.include && !r.error} disabled={!!r.error}
                          onChange={(e) => setNormRows(normRows.map((x) => (x.idx === r.idx ? { ...x, include: e.target.checked } : x)))} />
                      </td>
                      <td className="mono">{r.date ?? '—'}</td>
                      <td>{r.description || <span className="muted">—</span>}</td>
                      <td className="muted">{r.account || '—'}</td>
                      <td className="muted">{r.category ?? '—'}</td>
                      <td className="num">{r.amount != null ? `${num(r.amount)} ${r.currency}` : '—'}</td>
                      <td><TypeBadge type={r.type} /></td>
                      <td>
                        {r.error ? <span className="badge expense">{r.error}</span>
                          : r.duplicate ? <span className="badge warn">duplicate</span>
                          : r.duplicateInBatch ? <span className="badge warn">repeat in file</span>
                          : <span className="badge income">ok</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row mt16">
              <button onClick={() => setStep(1)}>← Back to mapping</button>
              <span className="spacer" />
              <button className="primary" disabled={busy || stats.willImport === 0} onClick={doImport}>
                {busy ? 'Importing & fetching rates…' : `Import ${stats.willImport} transactions`}
              </button>
            </div>
          </div>
        </>
      )}

      {step === 3 && result && (
        <div className="card">
          <h3>Import complete</h3>
          <p><b>{result.inserted}</b> transactions imported from {fileName}.</p>
          <ul className="small" style={{ color: 'var(--ink-2)' }}>
            {result.skippedDup > 0 && <li>{result.skippedDup} duplicates skipped</li>}
            {result.invalid > 0 && <li>{result.invalid} invalid rows skipped</li>}
            {result.fxMissing > 0 && (
              <li>
                {result.fxMissing} rows are missing an FX rate (API unreachable) — fix them later from the{' '}
                <Link to="/transactions">transactions page</Link> or re-run backfill.
              </li>
            )}
          </ul>
          <div className="row mt16">
            <Link to="/transactions" className="btn">View transactions</Link>
            <button onClick={() => { setStep(0); setRawRows([]); setNormRows([]); setResult(null); }}>Import another file</button>
          </div>
        </div>
      )}
      <Toast msg={toast} />
    </>
  );
}
