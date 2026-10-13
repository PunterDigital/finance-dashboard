import { ReactNode, useEffect, useState } from 'react';
import { api } from '../api';
import { czk, monthLabel } from '../format';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function StatTile({ label, value, delta, deltaLabel, upIsGood = true }: {
  label: string;
  value: string;
  delta?: number | null;
  deltaLabel?: string;
  upIsGood?: boolean;
}) {
  let deltaEl = null;
  if (delta != null && isFinite(delta)) {
    const up = delta >= 0;
    const good = up === upIsGood;
    deltaEl = (
      <div className={`delta ${good ? 'up' : 'down'}`}>
        {up ? '▲' : '▼'} {czk(Math.abs(delta))} {deltaLabel ?? 'vs last month'}
      </div>
    );
  }
  return (
    <div className="card stat-tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {deltaEl}
    </div>
  );
}

export function MonthPicker({ value, onChange, allowAll = false }: { value: string; onChange: (m: string) => void; allowAll?: boolean }) {
  const [months, setMonths] = useState<string[]>([]);
  useEffect(() => {
    api.get<string[]>('/api/months').then(setMonths).catch(() => setMonths([]));
  }, []);
  const opts = months.includes(value) || value === 'all' ? months : [value, ...months];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {allowAll && <option value="all">All months</option>}
      {opts.map((m) => (
        <option key={m} value={m}>{monthLabel(m)}</option>
      ))}
    </select>
  );
}

export function Toast({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <div className="toast">{msg}</div>;
}

export function useToast(): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  return [msg, setMsg];
}

export function TypeBadge({ type }: { type: string }) {
  const cls = type === 'Income' ? 'income' : type === 'Expense' ? 'expense' : 'transfer';
  return <span className={`badge ${cls}`}>{type}</span>;
}

// Shared Recharts tooltip
export function VizTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="viz-tooltip">
      <div className="t-title">{label}</div>
      {payload.map((p: any) => (
        <div className="t-row" key={p.dataKey}>
          <span className="swatch" style={{ background: p.color ?? p.fill }} />
          <span>{p.name}</span>
          <span className="v">{formatter ? formatter(p.value) : czk(p.value)}</span>
        </div>
      ))}
    </div>
  );
}
