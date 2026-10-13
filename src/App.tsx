import { NavLink, Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Transactions from './pages/Transactions';
import MonthlyReport from './pages/MonthlyReport';
import SpendPerCategory from './pages/SpendPerCategory';
import BurnRate from './pages/BurnRate';
import Recurring from './pages/Recurring';
import ImportPage from './pages/ImportPage';
import Transfers from './pages/Transfers';
import Settings from './pages/Settings';

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>
          <span>●</span> Finance
        </h1>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/transactions">Transactions</NavLink>
          <NavLink to="/transfers">Transfers</NavLink>
          <NavLink to="/import">Import CSV</NavLink>
          <div className="nav-section">Reports</div>
          <NavLink to="/monthly">Monthly Report</NavLink>
          <NavLink to="/categories">Spend per Category</NavLink>
          <NavLink to="/burn-rate">Burn Rate</NavLink>
          <NavLink to="/recurring">Recurring</NavLink>
          <div className="nav-section">Manage</div>
          <NavLink to="/settings">Accounts &amp; Categories</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/import" element={<ImportPage />} />
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
