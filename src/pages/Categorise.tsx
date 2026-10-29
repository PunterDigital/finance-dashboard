import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { dateLabel, num, czk } from '../format';
import { Category, Tx } from '../types';
import { Toast, useToast } from '../components/ui';

type QueuedTx = Tx & { suggestion: string | null };

// `saved` settles once the choice is stored, so an undo never overtakes its save.
interface Done { tx: QueuedTx; category: string; saved: Promise<boolean> }

// One entry in the picker: an existing category, or "add this as a new category".
type Option = { kind: 'pick'; cat: Category; suggested: boolean } | { kind: 'add'; name: string };

export function notifyCategoryChanged() {
  window.dispatchEvent(new Event('category-changed'));
  // A category set by hand can add a rule proposal to the Inbox (#3490).
  window.dispatchEvent(new Event('suggestions-changed'));
}

// Assign categories (#2892): one uncategorised income or expense row at a time, newest first, with a
// type-to-filter picker. Like the need/want sorter, a choice advances at once and saves in the
// background, and the handlers read state from refs so fast key presses are never dropped. Skips are
// saved too (#3344), so a skipped row stays out of the queue after a restart until "Review skipped".
export default function Categorise() {
  const [queue, setQueueState] = useState<QueuedTx[] | null>(null);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [filter, setFilter] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [historyCount, setHistoryCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast();
  const queueRef = useRef<QueuedTx[]>([]);
  // Skip saves in flight (each settles true/false, never rejects).
  const skipsRef = useRef<Promise<boolean>[]>([]);
  const historyRef = useRef<Done[]>([]);
  const loadingRef = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  const setQueue = (q: QueuedTx[]) => {
    queueRef.current = q;
    setQueueState(q);
  };
  const setHistory = (h: Done[]) => {
    historyRef.current = h;
    setHistoryCount(h.length);
  };
  const resetPicker = () => {
    setFilter('');
    setHighlight(0);
    input.current?.focus();
  };

  // Fetches the next batch, once every choice and skip in flight has landed (categorised and skipped
  // rows drop out server-side).
  const load = useCallback(async () => {
    loadingRef.current = true;
    setLoading(true);
    try {
      const skips = skipsRef.current;
      await Promise.all([...historyRef.current.map((d) => d.saved), ...skips]);
      skipsRef.current = skipsRef.current.filter((p) => !skips.includes(p));
      const d = await api.get<{ total: number; skipped: number; rows: QueuedTx[] }>('/api/category/queue?limit=100');
      setQueue(d.rows);
      setTotal(d.total);
      setSkippedCount(d.skipped);
    } catch (e: any) {
      setError(e.message);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    api.get<Category[]>('/api/categories').then(setCategories).catch((e: any) => setError(e.message));
  }, [load]);

  const current = queue?.[0] ?? null;

  const options = useMemo<Option[]>(() => {
    if (!current) return [];
    const q = filter.trim().toLowerCase();
    const ofType = categories.filter((c) => c.type === current.type);
    const matches = ofType.filter((c) => c.name.toLowerCase().includes(q));
    const suggested = matches.find((c) => c.name === current.suggestion);
    const list: Option[] = [
      ...(suggested ? [{ kind: 'pick' as const, cat: suggested, suggested: true }] : []),
      ...matches.filter((c) => c !== suggested).map((cat) => ({ kind: 'pick' as const, cat, suggested: false })),
    ];
    if (q && !categories.some((c) => c.name.toLowerCase() === q)) list.push({ kind: 'add', name: filter.trim() });
    return list;
  }, [current, categories, filter]);

  const advance = useCallback(() => {
    const rest = queueRef.current.slice(1);
    if (rest.length === 0) {
      setQueue([]);
      load();
    } else setQueue(rest);
  }, [load]);

  const assign = useCallback((category: string) => {
    const tx = queueRef.current[0];
    if (!tx || loadingRef.current) return;
    const saved = api
      .put(`/api/transactions/${tx.id}/category`, { category })
      .then(() => {
        notifyCategoryChanged();
        return true;
      })
      .catch((e: any) => {
        // Put it back so nothing is silently lost.
        showToast(`Couldn't save ${tx.description || 'transaction'}: ${e.message}`);
        setHistory(historyRef.current.filter((d) => d.tx.id !== tx.id));
        setTotal((t) => t + 1);
        setQueue([tx, ...queueRef.current]);
        return false;
      });
    setHistory([...historyRef.current, { tx, category, saved }]);
    setTotal((t) => t - 1);
    resetPicker();
    advance();
  }, [advance, showToast]);

  const choose = async (opt: Option | undefined) => {
    if (!opt || !current) return;
    if (opt.kind === 'pick') return assign(opt.cat.name);
    try {
      const cat = await api.post<Category>('/api/categories', { name: opt.name, type: current.type, grp: 'Other' });
      setCategories((cs) => [...cs, cat]);
      assign(cat.name);
    } catch (e: any) {
      showToast(`Couldn't add "${opt.name}": ${e.message}`);
    }
  };

  const skip = useCallback(() => {
    const tx = queueRef.current[0];
    if (!tx || loadingRef.current) return;
    const saved = api
      .put(`/api/transactions/${tx.id}/category-skip`, { skipped: true })
      .then(() => {
        notifyCategoryChanged();
        return true;
      })
      .catch((e: any) => {
        // Put it back so it isn't silently lost from this session.
        showToast(`Couldn't skip ${tx.description || 'transaction'}: ${e.message}`);
        setSkippedCount((n) => n - 1);
        setQueue([tx, ...queueRef.current]);
        return false;
      });
    skipsRef.current = [...skipsRef.current, saved];
    setSkippedCount((n) => n + 1);
    resetPicker();
    advance();
  }, [advance, showToast]);

  const undo = useCallback(async () => {
    const last = historyRef.current[historyRef.current.length - 1];
    if (!last) return;
    setHistory(historyRef.current.slice(0, -1));
    if (!(await last.saved)) return; // the save failed and already put the row back
    try {
      await api.put(`/api/transactions/${last.tx.id}/category`, { category: null });
      setTotal((t) => t + 1);
      setQueue([last.tx, ...queueRef.current]);
      resetPicker();
      notifyCategoryChanged();
      showToast(`Undone: ${last.tx.description || 'transaction'} has no category again`);
    } catch (e: any) {
      setHistory([...historyRef.current, last]);
      showToast(`Couldn't undo: ${e.message}`);
    }
  }, [showToast]);

  // Clears every saved skip, then reloads the queue with those rows back in it.
  const reviewSkipped = async () => {
    try {
      await Promise.all(skipsRef.current);
      await api.post('/api/category/skips/clear');
      notifyCategoryChanged();
    } catch (e: any) {
      showToast(`Couldn't bring the skipped ones back: ${e.message}`);
      return;
    }
    load();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); skip(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(options[highlight]); }
    else if (e.key === 'Escape') { e.preventDefault(); resetPicker(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
  };

  if (error) return <div className="callout warn">Failed to load: {error}</div>;
  if (!queue) return <div className="empty">Loading…</div>;

  const hi = Math.min(highlight, Math.max(options.length - 1, 0));

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Assign categories</h2>
          <div className="sub" data-testid="cat-remaining">
            {total} transaction{total === 1 ? '' : 's'} without a category
            {skippedCount > 0 && ` · ${skippedCount} skipped`}
          </div>
        </div>
        <div className="head-controls">
          <button onClick={undo} disabled={historyCount === 0}>↶ Undo</button>
        </div>
      </div>

      {current ? (
        <div className="sort-stage">
          <div key={current.id} className="card sort-card cat-card" aria-label={`${current.type}: ${current.description}`} data-testid="cat-card">
            <div className={`cat-type ${current.type.toLowerCase()}`}>{current.type}</div>
            <div className="sort-amount">{num(Math.abs(current.amount))} {current.currency}</div>
            {current.currency !== 'CZK' && current.amount_czk != null && (
              <div className="muted small">{czk(Math.abs(current.amount_czk))}</div>
            )}
            <div className="sort-desc">{current.description || <span className="muted">No description</span>}</div>
            <dl className="sort-meta">
              <dt>Date</dt><dd>{dateLabel(current.date)}</dd>
              <dt>Account</dt><dd>{current.account}</dd>
            </dl>
            {current.notes && <div className="muted small">{current.notes}</div>}
          </div>

          <div className="cat-picker">
            <input
              ref={input}
              autoFocus
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setHighlight(0); }}
              onKeyDown={onKeyDown}
              placeholder={`Type to find an ${current.type.toLowerCase()} category…`}
              aria-label="Find a category"
              aria-controls="cat-options"
              aria-activedescendant={options.length ? `cat-opt-${hi}` : undefined}
            />
            <div id="cat-options" className="cat-options" role="listbox" aria-label="Categories">
              {options.map((o, i) => (
                <button
                  key={o.kind === 'pick' ? o.cat.id : 'add'}
                  id={`cat-opt-${i}`}
                  role="option"
                  aria-selected={i === hi}
                  className={`cat-option${i === hi ? ' active' : ''}${o.kind === 'add' ? ' add' : ''}`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(o)}
                >
                  {o.kind === 'pick' ? (
                    <>
                      <span>{o.cat.name}</span>
                      <span className="muted small">{o.suggested ? 'Suggested' : o.cat.grp}</span>
                    </>
                  ) : (
                    <span>＋ Add “{o.name}” as a new {current.type.toLowerCase()} category</span>
                  )}
                </button>
              ))}
              {options.length === 0 && (
                <div className="muted small cat-none">
                  No {current.type.toLowerCase()} categories{filter ? ' match' : ' yet'}. Type a name to add one.
                </div>
              )}
            </div>
          </div>
          <div className="sort-actions">
            <button onClick={skip}>Skip</button>
          </div>
          <div className="muted small sort-hint">↑ / ↓ choose · Enter assigns · Shift+Enter skips · Esc clears · Ctrl+Z undoes</div>
        </div>
      ) : loading ? (
        <div className="empty">Loading…</div>
      ) : (
        <div className="card empty" data-testid="cat-done">
          {skippedCount > 0 ? (
            <>
              Everything else has a category. {skippedCount} skipped.{' '}
              <button onClick={reviewSkipped}>Review skipped</button>
            </>
          ) : (
            <>Every transaction has a category 🎉 <Link to="/categories">See spend per category →</Link></>
          )}
        </div>
      )}
      <Toast msg={toast} />
    </>
  );
}
