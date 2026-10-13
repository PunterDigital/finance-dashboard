# Finance Dashboard

A local-first personal finance dashboard for Windows and macOS. It replaces a Google Sheets tracker and its Apps Script (`app_script.txt`): transactions, CSV import from any bank, multi-currency FX conversion, burn rate, recurring payments and transfer matching. All data lives in a SQLite database on your own machine; nothing leaves it except FX-rate lookups.

## Download

Get the latest installer from the [downloads page](https://punterdigital.github.io/personal-apps/) or the [GitHub Releases](https://github.com/PunterDigital/finance-dashboard/releases). Builds are unsigned: on Windows click **More info → Run anyway** in SmartScreen; on macOS right-click the app and choose **Open** the first time.

Your data lives in the app's data folder (**File → Open data folder**):

- Windows: `%APPDATA%\Finance Dashboard\finance.db`
- macOS: `~/Library/Application Support/Finance Dashboard/finance.db`

**File → Back up database…** saves a single-file copy. **File → Import database…** replaces the current data with another `finance.db` (for example one from the dev setup below); the old database is kept next to it as `finance.db.bak-<timestamp>`.

## Develop

Requires Node 24+ (SQLite is Node's built-in `node:sqlite`; there are no native modules).

```bash
npm install
npm run seed      # optional, one-time: imports ./financial_tracker.xlsx (or a path you pass) into ./data
npm run dev       # API on 127.0.0.1:3178 + Vite UI on 5173; data in ./data/finance.db
npm start         # build and run the desktop app (data in the app's own folder)
```

Re-seeding: `npm run seed -- --force` wipes transactions/accounts/categories/budgets and re-imports from the spreadsheet (saved import templates and the FX cache are kept). The spreadsheet and `data/` are gitignored: they hold real financial data and must never be committed.

| Command | What |
|---|---|
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint |
| `npm test` | Unit + API tests (Vitest, each file on a throwaway database) |
| `npm run build` then `npm run test:e2e` | Playwright E2E against the Electron app, isolated profile |
| `npm run package` | Installer for the current OS in `dist-release/` |

## What's inside

| Page | Replaces | Notes |
|---|---|---|
| Dashboard | — | Monthly KPIs with vs-last-month deltas, income/expense trend, top categories, account flows, upcoming recurring |
| Transactions | Transactions tab | Filter/search/paginate, add/edit/delete; FX rate auto-fetched per transaction date when left blank |
| Import CSV | — (new) | Map any bank export's columns, save mappings as reusable templates, duplicate detection, per-date FX conversion |
| Monthly Report | Monthly Summary tab | Same figures, recomputed live |
| Spend per Category | Spend per Category tab | Month selector, group subtotals, drill-down to transactions |
| Burn Rate | Burn Rate tab | Editable budgets per group + income sources, burn %, cash runway |
| Recurring | Recurring tab + script | Detection ported from the Apps Script (fixed: no duplicate rows on re-run, keeps your active flags) |
| Transfers | — (new) | Auto-matches the two sides of each internal transfer (cross-currency aware) and infers direction; review page to flip/link/unlink |
| Accounts & Categories | Accounts/Categories tabs | CRUD; renames propagate to transactions |

## Currency conversion

Same behaviour as the Apps Script, done locally by the API server:
- Daily mid-market rates from **frankfurter.app** (ECB data, no API key); weekends resolve to the prior business day.
- Every fetched rate is cached in SQLite (`fx_rates`), and the seed warms the cache with the rates already in the spreadsheet, so historical amounts never re-fetch.
- If the API is unreachable, the newest known rate for that currency is used and the row is flagged so you can backfill later (`POST /api/fx/backfill`).

## Modelling notes

- **Transfers** are excluded from income/expense metrics (matching the Apps Script). Each transfer exists as two rows — money out of one account, money into another, often in different currencies. The Transfers page auto-matches sides (different accounts, dates within 4 days, CZK values within 3.5%) and infers direction from: conversion fees (the received side is slightly smaller), statement wording ("Wise Transfer" = incoming, "Transfer to me" = outgoing, counterpart's name in the description = incoming), date order (money can't arrive before it's sent), then directions learned from resolved pairs. Balances credit the destination with what actually arrived, so FX fees are naturally accounted for. Unresolved one-sided rows are excluded from balances until reviewed.
- Base currency is CZK throughout, matching the spreadsheet.

## CSV import templates

A template stores: column mapping (keyed by header names), date format, amount-sign convention (signed / inverted / debit+credit columns), default account/currency/category. Applying a template to a new file matches columns by header name, so it survives column reordering.
