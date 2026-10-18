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

// Size of a review queue (`total` from its endpoint) for a nav badge, refreshed on navigation and `event`.
function useQueueCount(url: string, event: string) {
  const [n, setN] = useState<number | null>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const refresh = () => api.get<{ total: number }>(url).then((d) => setN(d.total)).catch(() => {});
    refresh();
    window.addEventListener(event, refresh);
    return () => window.removeEventListener(event, refresh);
  }, [pathname, url, event]);
  return n;
}

export default function App() {
  const unsorted = useQueueCount('/api/necessity/queue?limit=1', 'necessity-changed');
  const uncategorised = useQueueCount('/api/category/queue?limit=1', 'category-changed');
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>
          <span>●</span> Finance
        </h1>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
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
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </aside>
      <main className="main">
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
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
