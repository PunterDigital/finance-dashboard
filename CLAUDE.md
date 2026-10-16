# Finance Dashboard

Local-first personal finance app: React SPA + Express API + SQLite, shipped as an Electron desktop
app for Windows and macOS. Repo: `PunterDigital/finance-dashboard` (public). Local folder name is
`personal-finance` (the GitHub name `personal-finance` belongs to a separate, private Laravel rewrite).

## Data safety (read first)

- `financial_tracker.xlsx` and `data/` hold Shay's **real** financial data. They are gitignored and
  must never be committed, uploaded, attached to cards, or printed into logs/transcripts.
- Tests never open real data: unit tests get a temp `FINANCE_DATA_DIR` (`tests/unit/setup.ts`);
  E2E launches Electron with `FINANCE_E2E_USER_DATA` pointing at a temp profile.
- The API has no auth. It must only ever bind to `127.0.0.1`, and `server/index.ts` rejects
  non-loopback `Host` headers (DNS-rebinding guard). Keep both.
- Schema changes must be additive migrations in `server/db.ts` (existing databases upgrade in place).

## Layout

| Path | What |
|---|---|
| `src/` | React UI (Vite). Pages in `src/pages/`, API client `src/api.ts` |
| `server/index.ts` | Express app (`app`, `serveStatic`, `listen`); routes under `/api` |
| `server/db.ts` | `node:sqlite` with a small better-sqlite3-style wrapper; schema + migrations |
| `server/main.ts` | Dev API entry (`npm run dev:server`) |
| `server/maintenance.ts` | Backup / validate / replace database (File menu) |
| `server/seed.ts` | `npm run seed [file.xlsx] [--force]`: one-off import of the old Google Sheets workbook |
| `server/workbook-import.ts` | The import itself (`importWorkbook`, `toDateStr`, `toAmount`); tested on a made-up workbook |
| `electron/main.ts` | Desktop shell: sets data dir, starts API on a random loopback port, loads UI |
| `tests/unit` | Vitest (API tests start the real server on port 0) |
| `tests/e2e` | Playwright `_electron` tests |

## Commands

```bash
npm ci
npm run dev          # API 127.0.0.1:3178 + Vite 5173, data in ./data
npm run typecheck && npm run lint && npm test
npm run build        # dist/ (UI) + dist-electron/main.js (main process, ESM, deps external)
npm run test:e2e     # needs a build first; FINANCE_E2E_EXECUTABLE=<path> tests a packaged app
npm run package      # electron-builder for the current OS
```

## Quirks

- No native modules on purpose: `node:sqlite` ships with Node 24 and Electron 44. Don't add
  better-sqlite3 back (it needs an Electron ABI rebuild).
- `server/db.ts` opens the database on import, so set `FINANCE_DATA_DIR` before importing the server
  (Electron main imports it dynamically for that reason).
- `db.transaction()` uses SAVEPOINTs so blocks nest, like better-sqlite3 did.
- `dist-electron/main.js` is bundled with `--packages=external`; only `dependencies` (just Express)
  are packaged into the app. UI libraries are devDependencies because Vite bundles them.
- macOS builds are universal and ad-hoc signed in `scripts/after-pack.cjs`; CI runs
  `codesign --verify --deep --strict`.
- Label text includes a `<select>`'s options in Playwright, so select comboboxes by role + name.
- `xlsx` (dev-only, for the seed) comes from SheetJS's own CDN tarball (`cdn.sheetjs.com`): the npm
  package stopped at 0.18.5, which has high advisories. Dependabot can't update a URL dependency;
  to upgrade, `npm i -D https://cdn.sheetjs.com/xlsx-<v>/xlsx-<v>.tgz`. Read files with
  `xlsx.read(fs.readFileSync(p))`: the ESM build's `readFile` needs `set_fs` first.
- FX rates come from frankfurter (no key). Use CZK in tests to avoid network calls.
