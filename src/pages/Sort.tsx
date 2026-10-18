import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { dateLabel, num, czk } from '../format';
import { Necessity, Tx } from '../types';
import { Toast, useToast } from '../components/ui';

// How far (px) a card has to be dragged before letting go counts as a choice.
const SWIPE_AT = 110;

// `saved` settles once the choice is stored, so an undo never overtakes its save.
interface Done { tx: Tx; choice: Necessity; saved: Promise<boolean> }

export function notifyNecessityChanged() {
  window.dispatchEvent(new Event('necessity-changed'));
}

// Need-vs-want sorter (#2818): one unsorted expense at a time, newest first. Choices advance the
// card at once and save in the background, so fast key presses are never dropped. State that the
// handlers read lives in refs (mirrored into React state for rendering) for the same reason.
export default function Sort() {
  const [queue, setQueueState] = useState<Tx[] | null>(null);
  const [total, setTotal] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [historyCount, setHistoryCount] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast();
  const queueRef = useRef<Tx[]>([]);
  const skippedRef = useRef<number[]>([]);
  const historyRef = useRef<Done[]>([]);
  const loadingRef = useRef(false);
  const drag = useRef<{ startX: number } | null>(null);

  const setQueue = (q: Tx[]) => {
    queueRef.current = q;
    setQueueState(q);
  };
  const setHistory = (h: Done[]) => {
    historyRef.current = h;
    setHistoryCount(h.length);
  };

  // Fetches the next batch, once every save in flight has landed (sorted rows drop out server-side).
  const load = useCallback(async () => {
    loadingRef.current = true;
    setLoading(true);
    try {
      await Promise.all(historyRef.current.map((d) => d.saved));
      const d = await api.get<{ total: number; rows: Tx[] }>(
        `/api/necessity/queue?limit=100&exclude=${skippedRef.current.join(',')}`
      );
      setQueue(d.rows);
      setTotal(d.total);
    } catch (e: any) {
      setError(e.message);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const advance = useCallback(() => {
    const rest = queueRef.current.slice(1);
    if (rest.length === 0) {
      setQueue([]);
      load();
    } else setQueue(rest);
  }, [load]);

  const choose = useCallback((choice: Necessity) => {
    const tx = queueRef.current[0];
    setDragX(0);
    if (!tx || loadingRef.current) return;
    const saved = api
      .put(`/api/transactions/${tx.id}/necessity`, { necessity: choice })
      .then(() => {
        notifyNecessityChanged();
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
    setHistory([...historyRef.current, { tx, choice, saved }]);
    setTotal((t) => t - 1);
    advance();
  }, [advance, showToast]);

  const skip = useCallback(() => {
    const tx = queueRef.current[0];
    if (!tx || loadingRef.current) return;
    skippedRef.current = [...skippedRef.current, tx.id];
    setSkippedCount(skippedRef.current.length);
    advance();
  }, [advance]);

  const undo = useCallback(async () => {
    const last = historyRef.current[historyRef.current.length - 1];
    if (!last) return;
    setHistory(historyRef.current.slice(0, -1));
    if (!(await last.saved)) return; // the save failed and already put the row back
    try {
      await api.put(`/api/transactions/${last.tx.id}/necessity`, { necessity: null });
      setTotal((t) => t + 1);
      setQueue([last.tx, ...queueRef.current]);
      notifyNecessityChanged();
      showToast(`Undone: ${last.tx.description || 'transaction'} is unsorted again`);
    } catch (e: any) {
      setHistory([...historyRef.current, last]);
      showToast(`Couldn't undo: ${e.message}`);
    }
  }, [showToast]);

  const reviewSkipped = () => {
    skippedRef.current = [];
    setSkippedCount(0);
    load();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, select, textarea') || e.altKey || e.metaKey || (e.ctrlKey && e.key !== 'z')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); choose('want'); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); choose('need'); }
      else if (e.key === 'ArrowDown' || e.key === 's') { e.preventDefault(); skip(); }
      else if (e.key === 'Backspace' || e.key === 'u' || (e.ctrlKey && e.key === 'z')) { e.preventDefault(); undo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choose, skip, undo]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current) setDragX(e.clientX - drag.current.startX);
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (dragX >= SWIPE_AT) choose('need');
    else if (dragX <= -SWIPE_AT) choose('want');
    else setDragX(0);
  };

  if (error) return <div className="callout warn">Failed to load: {error}</div>;
  if (!queue) return <div className="empty">Loading…</div>;

  const current = queue[0] ?? null;
  const leaning = dragX >= SWIPE_AT / 2 ? 'need' : dragX <= -SWIPE_AT / 2 ? 'want' : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Sort: need or want?</h2>
          <div className="sub" data-testid="sort-remaining">
            {total} unsorted expense{total === 1 ? '' : 's'}
            {skippedCount > 0 && ` · ${skippedCount} skipped`}
          </div>
        </div>
        <div className="head-controls">
          <button onClick={undo} disabled={historyCount === 0}>↶ Undo</button>
        </div>
      </div>

      {current ? (
        <div className="sort-stage">
          <div
            key={current.id}
            className={`card sort-card${leaning ? ` lean-${leaning}` : ''}`}
            style={{ transform: `translateX(${dragX}px) rotate(${dragX / 25}deg)`, transition: drag.current ? 'none' : undefined }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { drag.current = null; setDragX(0); }}
            aria-label={`Expense: ${current.description}`}
            data-testid="sort-card"
          >
            {leaning && <div className={`sort-stamp ${leaning}`}>{leaning === 'need' ? 'Need' : 'Want'}</div>}
            <div className="sort-amount">{num(Math.abs(current.amount))} {current.currency}</div>
            {current.currency !== 'CZK' && current.amount_czk != null && (
              <div className="muted small">{czk(Math.abs(current.amount_czk))}</div>
            )}
            <div className="sort-desc">{current.description || <span className="muted">No description</span>}</div>
            <dl className="sort-meta">
              <dt>Date</dt><dd>{dateLabel(current.date)}</dd>
              <dt>Account</dt><dd>{current.account}</dd>
              <dt>Category</dt><dd>{current.category ?? '—'}</dd>
            </dl>
            {current.notes && <div className="muted small">{current.notes}</div>}
          </div>
          <div className="sort-actions">
            <button className="sort-btn want" onClick={() => choose('want')}>← Want</button>
            <button onClick={skip}>Skip</button>
            <button className="sort-btn need" onClick={() => choose('need')}>Need →</button>
          </div>
          <div className="muted small sort-hint">Drag the card left or right, or use ← / → · ↓ skips · Backspace undoes</div>
        </div>
      ) : loading ? (
        <div className="empty">Loading…</div>
      ) : (
        <div className="card empty" data-testid="sort-done">
          {skippedCount > 0 ? (
            <>
              Everything else is sorted. {skippedCount} skipped.{' '}
              <button onClick={reviewSkipped}>Review skipped</button>
            </>
          ) : (
            <>All expenses are sorted 🎉 <Link to="/">See the split on the dashboard →</Link></>
          )}
        </div>
      )}
      <Toast msg={toast} />
    </>
  );
}
