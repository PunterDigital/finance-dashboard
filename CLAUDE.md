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
| `src/pages/Sort.tsx` | Need/want sorter (#2818): `transactions.necessity` (`need`/`want`/NULL, expenses only), `PUT /api/transactions/:id/necessity` (also clears the skip), `GET /api/necessity/queue` (`total` = every unsorted expense, `skipped` = how many of those are skipped, `rows` = unskipped only). Skips are saved (#3344): `transactions.necessity_skipped` (0/1), `PUT /api/transactions/:id/necessity-skip` `{ skipped }`, "Review skipped" = `POST /api/necessity/skips/clear` |
| `src/pages/Categorise.tsx` | Assign categories (#2892): uncategorised income/expense rows (NULL or blank; transfers never), `PUT /api/transactions/:id/category` (must exist and match the row's type; also clears the skip), `GET /api/category/queue` (`total`/`skipped`/`rows` like the sorter's) with a `suggestion` per row (most-used category for the same description, matched in JS because SQLite's `lower()` is ASCII-only). Saved skips (#3344): `transactions.category_skipped` (0/1, also cleared when the editor gives the row a category), `PUT /api/transactions/:id/category-skip` `{ skipped }`, `POST /api/category/skips/clear` |
| `server/rules.ts`, `src/pages/Rules.tsx` | Category rules (#3488): `rules` (status, `current_version`), `rule_versions` (append-only: a trigger refuses UPDATE; edits, rollbacks and category renames write a new version), `rule_audit` (before/after JSON). Exact or contains on the normalised description (`normalise()`: NFC, collapsed spaces, `cs` lower case), optional account and amount range (compared without sign). Precedence: exact > contains, longer > shorter, account > general; equal-rank matches with different categories = conflict, no change. `transactions.category_source` (`user`/`rule`/`llm`/`import`, NULL = none; pre-#3488 categories became `user`) + `category_rule_id`/`_version`. Rules only touch rows with no category or a rule-set one; any category set by hand (editor, Categorise page, manual add) is `user` and clears the rule ids. They run on CSV import (new rows), `POST /api/rules/apply`, and on save (`POST /api/rules`, `PUT /api/rules/:id`: rows the rule now wins plus rows it had set) and rollback (`POST /api/rules/:id/rollback`: only rows it set). Every write has a `.../preview` twin returning `{ count, conflicts, rows (≤50) }`. Retire keeps the categories it set |
| `server/recurring.ts` | Recurring detector (`POST /api/recurring/detect`): patterns by normalised description + amount (rounded to 10) + currency, then chained per description when the next pattern starts 0.5–1.5 intervals after the last one ends (a price change, #3487: `recurring.previous_amount` + `price_changed_on`). Patterns that overlap in time stay separate items (two products from one merchant); the upsert matches those by nearest amount. "Missed, maybe stopped" is client-side (`src/recurring-status.ts`, grace per frequency) |
| `electron/main.ts` | Desktop shell: sets data dir, starts API on a random loopback port, loads UI |
| `electron/updater-core.ts`, `electron/updater.ts` | App updates (#3353): logic (no Electron imports, `tests/unit/updater.test.ts`) and wiring. The UI reads it over the API (`server/updates.ts`, `/api/app/update`, `/check`, `/install`): the renderer has no preload. Bar: `src/components/UpdateBanner.tsx` |
| `server/app-settings.ts` | App preferences outside the database: `app-settings.json` in the data dir (`checkForUpdates`, default on), `GET/PUT /api/app/settings` |
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
- `dist-electron/main.js` is bundled with `--packages=external`; only `dependencies` (Express, electron-updater)
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
  Skips work the same way on both sorters (advance at once, save in the background); `load()` waits
  for in-flight skips as well as choices. The sidebar badges show `total - skipped` (what's left to do).
- App updates (#3353, ported from Nexus SSH): Windows (`install`) uses electron-updater against GitHub Releases
  (`latest.yml` + the `.exe.blockmap`, published by `release.yml`; `electron-builder.yml`'s `publish` block writes
  `resources/app-update.yml` into the app), downloads in the background (`autoInstallOnAppQuit = false`) and
  "Restart to update" runs `quitAndInstall(true, true)`. macOS (`notify`) reads the GitHub API's latest release
  and "Download" opens the downloads page (an unsigned app can't self-update). Dev builds and E2E profiles are
  `off`. First check 5 s after launch, then every 6 h, each one only if Settings → "Check for updates" is on.
  `dist-electron/main.js` is ESM, so electron-updater is loaded lazily with `createRequire(import.meta.url)`
  (an `import()` of it loses the `autoUpdater` getter in the packaged app, per Nexus).
- Update env vars: `FINANCE_UPDATE_TEST_URL=<url>` = notify mode against a fake GitHub "latest release" JSON
  (`tests/e2e/updates.spec.ts`); `FINANCE_UPDATE_IN_TEST_PROFILE=1` lets a packaged build with an E2E profile run
  the real updater; `FINANCE_DISABLE_UPDATES=1` turns it all off.
- Testing the real Windows updater: `npx electron-builder --win --publish never -c.extraMetadata.version=0.4.0
  -c.directories.output=<scratch>` (`--dir` writes no `app-update.yml`, so build the NSIS target), launch
  `win-unpacked` with `FINANCE_E2E_USER_DATA=<temp>` + `FINANCE_UPDATE_IN_TEST_PROFILE=1`, and read
  `/api/app/update`. For a local feed, rewrite `resources/app-update.yml` to `provider: generic` + `url:` (a
  `-c.publish.provider=generic` override fails electron-builder's schema) and serve `latest.yml` + the installer.
  Never click "Restart to update". Afterwards delete only `%LOCALAPPDATA%/finance-dashboard-updater/pending`:
  the folder's `installer.exe` belongs to the real install (NSIS keeps a copy there for differential updates).
- E2E restarts: the `relaunch()` fixture (`tests/e2e/app.ts`) closes the app and starts it again on the
  same temp profile, returning the new window. Wait for background saves to land (poll the API) before
  calling it.
