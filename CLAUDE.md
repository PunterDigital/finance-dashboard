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
| `src/import-mapping.ts` | Guesses CSV column roles from headers (Type/Account/Category also check the values) |
| `server/index.ts` | Express app (`app`, `serveStatic`, `listen`); routes under `/api` |
| `server/db.ts` | `node:sqlite` with a small better-sqlite3-style wrapper; schema + migrations |
| `server/main.ts` | Dev API entry (`npm run dev:server`) |
| `server/maintenance.ts` | Backup / validate / replace / reset database (File menu; Settings page via `/api/maintenance/*`) |
| `server/seed.ts` | `npm run seed [file.xlsx] [--force]`: one-off import of the old Google Sheets workbook |
| `server/workbook-import.ts` | The import itself (`importWorkbook`, `toDateStr`, `toAmount`); tested on a made-up workbook |
| `src/pages/Sort.tsx` | Need/want sorter (#2818): `transactions.necessity` (`need`/`want`/NULL, expenses only), `PUT /api/transactions/:id/necessity`, `GET /api/necessity/queue` |
| `src/pages/Categorise.tsx` | Assign categories (#2892): uncategorised income/expense rows (NULL or blank; transfers never), `PUT /api/transactions/:id/category` (must exist and match the row's type), `GET /api/category/queue` with a `suggestion` per row (most-used category for the same description, matched in JS because SQLite's `lower()` is ASCII-only) |
| `electron/main.ts` | Desktop shell: sets data dir, starts API on a random loopback port, loads UI |
| `build/` | App icon: `icon.svg` source → `icon.png`/`.ico`/`.icns` (`scripts/make-icons.mjs`), electron-builder `buildResources` |
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

- No native modules on purpose: `node:sqlite` ships with Node 24 and Electron 45. Don't add
  better-sqlite3 back (it needs an Electron ABI rebuild).
- `server/db.ts` opens the database on import, so set `FINANCE_DATA_DIR` before importing the server
  (Electron main imports it dynamically for that reason).
- `db.transaction()` uses SAVEPOINTs so blocks nest, like better-sqlite3 did.
- `dist-electron/main.js` is bundled with `--packages=external`; only `dependencies` (just Express)
  are packaged into the app. UI libraries are devDependencies because Vite bundles them.
- App icon: edit `build/icon.svg`, then `npm i --no-save sharp png2icons && node scripts/make-icons.mjs` and
  commit all four files. `win.signAndEditExecutable: true` is what stamps the icon into the `.exe` (rcedit,
  no certificate needed); CI checks the exe/installer icon (`scripts/check-win-icon.ps1`) and the
  macOS bundle's `.icns`.
- macOS builds are universal and ad-hoc signed in `scripts/after-pack.cjs`; CI runs
  `codesign --verify --deep --strict`.
- Label text includes a `<select>`'s options in Playwright, so select comboboxes by role + name.
  Row text does too: on Transfers every unpaired row's "Link with…" lists the other accounts, so
  `filter({ hasText })` matches the wrong row. Filter by the account cell (`transfers.spec.ts`).
- `xlsx` (dev-only, for the seed) comes from SheetJS's own CDN tarball (`cdn.sheetjs.com`): the npm
  package stopped at 0.18.5, which has high advisories. Dependabot can't update a URL dependency;
  to upgrade, `npm i -D https://cdn.sheetjs.com/xlsx-<v>/xlsx-<v>.tgz`. Read files with
  `xlsx.read(fs.readFileSync(p))`: the ESM build's `readFile` needs `set_fs` first.
- TypeScript stays on 6.x (#3272): TypeScript 7's npm package has no JS compiler API (its main export is a
  version file), and typescript-eslint 8 refuses to load with it ("typescript-eslint does not support TS
  7.0"; peer range `<6.1.0`, tracked in typescript-eslint#10940). `tsc` 7 itself typechecks the project
  clean. Move when typescript-eslint's `typescript` peer range includes 7. TS 6 turns on
  `noUncheckedSideEffectImports`, so `tsconfig.json` lists `vite/client` in `types` for `import './styles.css'`.
- React Router 8 is ESM-only and needs React 19.2.7+ and Node 22.22+. The app only uses declarative
  `HashRouter`/`Routes`/`NavLink`/`Link`/`useLocation` from `react-router`; the smoke E2E clicks every
  sidebar route, so add new routes to its list.
- FX rates come from frankfurter (no key). Use CZK in tests to avoid network calls.
- Settings → Back up database is a plain download (the app shows a save dialog). Playwright doesn't
  surface Electron downloads as `download` events: in E2E, set the path with a `will-download`
  handler via `app.evaluate`. Don't delete a file inside a `res.download` callback: on Windows the
  stream still has it open (ENOTEMPTY crashed the main process); send a Buffer instead.
- The need/want sorter advances the card at once and saves in the background (a choice saved while the
  next key press is handled would otherwise be dropped). Its handlers read state from refs; an undo waits
  for its own save first. A non-Expense row never keeps a necessity (the full PUT clears it).
