import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router';
import { api } from './api';
import Dashboard from './pages/Dashboard';
import Transactions from './pages/Transactions';
import MonthlyReport from './pages/MonthlyReport';
import SpendPerCategory from './pages/SpendPerCategory';
import BurnRate from './pages/BurnRate';
import Recurring from './pages/Recurring';
import ImportPage from './pages/ImportPage';
import Transfers from './pages/Transfers';
import Settings from './pages/Settings';
import Sort from './pages/Sort';
import Categorise from './pages/Categorise';
import Rules from './pages/Rules';
import Inbox from './pages/Inbox';
import { APP_VERSION } from './version';
import UpdateBanner from './components/UpdateBanner';

// A count for a nav badge, read from `url` with `pick`. Refreshed on navigation and `event`.
function useNavCount<T>(url: string, event: string, pick: (d: T) => number) {
  const [n, setN] = useState<number | null>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const refresh = () => api.get<T>(url).then((d) => setN(pick(d))).catch(() => {});
    refresh();
    window.addEventListener(event, refresh);
    return () => window.removeEventListener(event, refresh);
  }, [pathname, url, event, pick]);
  return n;
}

// What's left to do in a review queue: rows still to go through, not counting the ones skipped (#3344).
const leftToDo = (d: { total: number; skipped: number }) => d.total - d.skipped;
const pendingSuggestions = (d: { pending: number }) => d.pending;

export default function App() {
  const unsorted = useNavCount('/api/necessity/queue?limit=1', 'necessity-changed', leftToDo);
  const uncategorised = useNavCount('/api/category/queue?limit=1', 'category-changed', leftToDo);
  const inbox = useNavCount('/api/suggestions/count', 'suggestions-changed', pendingSuggestions);
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>
          <span>●</span> Finance
        </h1>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/inbox">
            Inbox
            {inbox ? <span className="nav-count" aria-label={`${inbox} to review`}>{inbox}</span> : null}
          </NavLink>
          <NavLink to="/transactions">Transactions</NavLink>
          <NavLink to="/sort">
            Sort need/want
            {unsorted ? <span className="nav-count" aria-label={`${unsorted} unsorted`}>{unsorted}</span> : null}
          </NavLink>
          <NavLink to="/categorise">
            Assign categories
            {uncategorised ? <span className="nav-count" aria-label={`${uncategorised} without a category`}>{uncategorised}</span> : null}
          </NavLink>
          <NavLink to="/transfers">Transfers</NavLink>
          <NavLink to="/import">Import CSV</NavLink>
          <div className="nav-section">Reports</div>
          <NavLink to="/monthly">Monthly Report</NavLink>
          <NavLink to="/categories">Spend per Category</NavLink>
          <NavLink to="/burn-rate">Burn Rate</NavLink>
          <NavLink to="/recurring">Recurring</NavLink>
          <div className="nav-section">Manage</div>
          <NavLink to="/rules">Rules</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="sidebar-version" data-testid="app-version">v{APP_VERSION}</div>
      </aside>
      <main className="main">
        <div className="main-inner">
          <UpdateBanner />
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/sort" element={<Sort />} />
            <Route path="/categorise" element={<Categorise />} />
            <Route path="/transfers" element={<Transfers />} />
            <Route path="/monthly" element={<MonthlyReport />} />
            <Route path="/categories" element={<SpendPerCategory />} />
            <Route path="/burn-rate" element={<BurnRate />} />
            <Route path="/recurring" element={<Recurring />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
