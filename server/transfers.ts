import { db } from './db.js';

// Pairs up the two sides of internal transfers. The sheet records each side as
// its own row (often in different currencies — EUR out, CZK in via Wise), so:
//   match:     different accounts, dates within 4 days, CZK values within
//              3.5% (+200 Kč floor) — or identical currency+amount
//   direction: fees make the received side slightly smaller; statement text
//              gives hints ("Wise Transfer" = incoming, "Transfer to me" =
//              outgoing, counterpart's name in the description = incoming);
//              remaining ties fall back to directions learned from resolved
//              pairs for the same account pair, then Business→Personal.

export interface TransferRow {
  id: number;
  date: string;
  description: string;
  account: string;
  amount: number;
  currency: string;
  amount_czk: number | null;
  transfer_pair_id: number | null;
  transfer_role: string | null;
}

const SENDER_HINT = /transfer to|to me|to biz|payout to/i;
const RECEIVER_HINT = /wise transfer|received|\bfrom\b/i;

function normName(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/limited|ltd|s\.r\.o\.?/g, '').replace(/[^a-z0-9]/g, '');
}

function dateDiffDays(a: string, b: string): number {
  return Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;
}

function czkClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(200, Math.max(Math.abs(a), Math.abs(b)) * 0.035);
}

function getAccountMeta(): Map<string, { type: string; entity: string | null }> {
  const accs = db.prepare('SELECT name, type, entity FROM accounts').all() as any[];
  return new Map(accs.map((a) => [a.name, { type: a.type, entity: a.entity }]));
}

// Returns [sender, receiver] or null when rules can't decide.
function inferDirection(
  a: TransferRow,
  b: TransferRow,
  meta: Map<string, { type: string; entity: string | null }>,
  learned: Map<string, number> | null
): [TransferRow, TransferRow] | null {
  const ac = Math.abs(a.amount_czk ?? 0);
  const bc = Math.abs(b.amount_czk ?? 0);
  // Fee rule: what arrives is less than what was sent
  if (Math.abs(ac - bc) > Math.max(1, Math.max(ac, bc) * 0.0005)) {
    return ac > bc ? [a, b] : [b, a];
  }
  const aOut = SENDER_HINT.test(a.description);
  const bOut = SENDER_HINT.test(b.description);
  if (aOut !== bOut) return aOut ? [a, b] : [b, a];
  const aIn = RECEIVER_HINT.test(a.description);
  const bIn = RECEIVER_HINT.test(b.description);
  if (aIn !== bIn) return aIn ? [b, a] : [a, b];
  // The receiving statement often names who the money came from
  const aNamesB =
    normName(a.description).includes(normName(b.account)) ||
    (meta.get(b.account)?.entity ? normName(a.description).includes(normName(meta.get(b.account)!.entity)) : false);
  const bNamesA =
    normName(b.description).includes(normName(a.account)) ||
    (meta.get(a.account)?.entity ? normName(b.description).includes(normName(meta.get(a.account)!.entity)) : false);
  if (aNamesB !== bNamesA) return aNamesB ? [b, a] : [a, b];
  // Money can't arrive before it's sent
  if (a.date !== b.date) return a.date < b.date ? [a, b] : [b, a];

  if (learned) {
    const ab = learned.get(`${a.account}→${b.account}`) ?? 0;
    const ba = learned.get(`${b.account}→${a.account}`) ?? 0;
    if (ab !== ba) return ab > ba ? [a, b] : [b, a];
    const aType = meta.get(a.account)?.type;
    const bType = meta.get(b.account)?.type;
    if (aType === 'Business' && bType === 'Personal') return [a, b];
    if (bType === 'Business' && aType === 'Personal') return [b, a];
    // Deterministic last resort — reviewable in the UI
    return a.account < b.account ? [a, b] : [b, a];
  }
  return null;
}

export function autoMatchTransfers() {
  const meta = getAccountMeta();
  const all = db
    .prepare(
      `SELECT id, date, description, account, amount, currency, amount_czk, transfer_pair_id, transfer_role
       FROM transactions WHERE type='Transfer' ORDER BY date, id`
    )
    .all() as TransferRow[];

  // Directions already resolved (auto or manual) seed the learned map
  const learned = new Map<string, number>();
  const byId = new Map(all.map((r) => [r.id, r]));
  for (const r of all) {
    if (r.transfer_role === 'out' && r.transfer_pair_id != null) {
      const other = byId.get(r.transfer_pair_id);
      if (other) learned.set(`${r.account}→${other.account}`, (learned.get(`${r.account}→${other.account}`) ?? 0) + 1);
    }
  }

  const unresolved = all.filter((r) => r.transfer_pair_id == null && r.transfer_role == null && r.amount_czk != null);

  // Candidate pairs, best first: exact currency+amount, then closest date, then closest value
  interface Cand { a: TransferRow; b: TransferRow; exact: boolean; dd: number; vd: number }
  const cands: Cand[] = [];
  for (let i = 0; i < unresolved.length; i++) {
    for (let j = i + 1; j < unresolved.length; j++) {
      const a = unresolved[i], b = unresolved[j];
      if (a.account === b.account) continue;
      const dd = dateDiffDays(a.date, b.date);
      if (dd > 4) continue;
      const exact = a.currency === b.currency && Math.abs(a.amount - b.amount) < 0.005;
      const vd = Math.abs(Math.abs(a.amount_czk!) - Math.abs(b.amount_czk!));
      if (!exact && !czkClose(Math.abs(a.amount_czk!), Math.abs(b.amount_czk!))) continue;
      cands.push({ a, b, exact, dd, vd });
    }
  }
  cands.sort((x, y) => Number(y.exact) - Number(x.exact) || x.dd - y.dd || x.vd - y.vd);

  const used = new Set<number>();
  const matched: [TransferRow, TransferRow][] = [];
  for (const c of cands) {
    if (used.has(c.a.id) || used.has(c.b.id)) continue;
    used.add(c.a.id);
    used.add(c.b.id);
    matched.push([c.a, c.b]);
  }

  // Pass 1: fee/description rules; winners teach the learned map
  const directed: [TransferRow, TransferRow][] = [];
  const pending: [TransferRow, TransferRow][] = [];
  for (const [a, b] of matched) {
    const d = inferDirection(a, b, meta, null);
    if (d) {
      directed.push(d);
      learned.set(`${d[0].account}→${d[1].account}`, (learned.get(`${d[0].account}→${d[1].account}`) ?? 0) + 1);
    } else pending.push([a, b]);
  }
  // Pass 2: learned directions + type fallback (always resolves)
  for (const [a, b] of pending) directed.push(inferDirection(a, b, meta, learned)!);

  const setPair = db.prepare('UPDATE transactions SET transfer_pair_id=?, transfer_role=? WHERE id=?');
  const commit = db.transaction(() => {
    for (const [out, inn] of directed) {
      setPair.run(inn.id, 'out', out.id);
      setPair.run(out.id, 'in', inn.id);
    }
  });
  commit();

  const crossCurrency = directed.filter(([o, i]) => o.currency !== i.currency).length;
  const stillUnpaired = unresolved.length - directed.length * 2;
  return { paired: directed.length, crossCurrency, unpaired: stillUnpaired };
}

export function listTransfers() {
  const all = db
    .prepare(
      `SELECT id, date, description, account, amount, currency, amount_czk, transfer_pair_id, transfer_role
       FROM transactions WHERE type='Transfer' ORDER BY date DESC, id DESC`
    )
    .all() as TransferRow[];
  const byId = new Map(all.map((r) => [r.id, r]));
  const pairs: { out: TransferRow; in: TransferRow; feeCzk: number }[] = [];
  const seen = new Set<number>();
  for (const r of all) {
    if (r.transfer_role === 'out' && r.transfer_pair_id != null && !seen.has(r.id)) {
      const inn = byId.get(r.transfer_pair_id);
      if (inn) {
        pairs.push({ out: r, in: inn, feeCzk: Math.abs(r.amount_czk ?? 0) - Math.abs(inn.amount_czk ?? 0) });
        seen.add(r.id);
        seen.add(inn.id);
      }
    }
  }
  const unpaired = all.filter((r) => r.transfer_pair_id == null);
  return { pairs, unpaired };
}

export function linkTransfers(outId: number, inId: number) {
  unlinkTransfer(outId);
  unlinkTransfer(inId);
  db.prepare("UPDATE transactions SET transfer_pair_id=?, transfer_role='out' WHERE id=?").run(inId, outId);
  db.prepare("UPDATE transactions SET transfer_pair_id=?, transfer_role='in' WHERE id=?").run(outId, inId);
}

export function unlinkTransfer(id: number) {
  const row = db.prepare('SELECT transfer_pair_id FROM transactions WHERE id=?').get(id) as any;
  if (row?.transfer_pair_id != null) {
    db.prepare('UPDATE transactions SET transfer_pair_id=NULL, transfer_role=NULL WHERE id=?').run(row.transfer_pair_id);
  }
  db.prepare('UPDATE transactions SET transfer_pair_id=NULL, transfer_role=NULL WHERE id=?').run(id);
}

export function flipTransfer(id: number) {
  const row = db.prepare('SELECT id, transfer_pair_id, transfer_role FROM transactions WHERE id=?').get(id) as any;
  if (!row) return;
  const swap = (r: any) => (r === 'out' ? 'in' : 'out');
  if (row.transfer_pair_id != null) {
    const other = db.prepare('SELECT id, transfer_role FROM transactions WHERE id=?').get(row.transfer_pair_id) as any;
    db.prepare('UPDATE transactions SET transfer_role=? WHERE id=?').run(swap(row.transfer_role), row.id);
    if (other) db.prepare('UPDATE transactions SET transfer_role=? WHERE id=?').run(swap(other.transfer_role), other.id);
  }
}

export function setTransferRole(id: number, role: 'out' | 'in' | null) {
  const row = db.prepare('SELECT transfer_pair_id FROM transactions WHERE id=?').get(id) as any;
  if (row?.transfer_pair_id != null) unlinkTransfer(id);
  db.prepare('UPDATE transactions SET transfer_role=? WHERE id=?').run(role, id);
}

export function resetTransfers() {
  db.prepare("UPDATE transactions SET transfer_pair_id=NULL, transfer_role=NULL WHERE type='Transfer'").run();
}
