import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { db, dbPath } from './db.js';

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

// Consistent single-file copy of the live database (includes anything still in the WAL).
export function backupDatabase(dest: string) {
  fs.rmSync(dest, { force: true });
  db.exec(`VACUUM INTO ${sqlString(dest)}`);
}

// Throws unless `file` is a SQLite database created by this app.
export function validateDatabase(file: string) {
  let src: DatabaseSync;
  try {
    src = new DatabaseSync(file, { readOnly: true });
  } catch {
    throw new Error('Not a readable SQLite database');
  }
  try {
    const row = src
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('transactions','accounts','categories')")
      .get() as { n: number } | undefined;
    if (row?.n !== 3) throw new Error('This database was not created by Finance Dashboard');
  } catch (err) {
    throw err instanceof Error && err.message.startsWith('This database') ? err : new Error('Not a readable SQLite database');
  } finally {
    src.close();
  }
}

// Replaces the live database with `src`, keeping the old one as finance.db.bak-<timestamp>.
// Closes the connection: the caller must restart the process afterwards.
export function replaceDatabase(src: string): string {
  validateDatabase(src);
  const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  backupDatabase(backup);
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  // VACUUM INTO reads through the source's WAL, so an unflushed dev database copies completely.
  const source = new DatabaseSync(src, { readOnly: true });
  try {
    source.exec(`VACUUM INTO ${sqlString(dbPath)}`);
  } finally {
    source.close();
  }
  return backup;
}

// Empties every table, keeping the schema, so the app starts over as on a first install. The live
// database is first kept as finance.db.bak-<timestamp> (returned), and the connection stays open.
export function resetDatabase(): string {
  const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  backupDatabase(backup);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
  ).map((t) => t.name);
  const hasSequence = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get();
  db.transaction(() => {
    for (const t of tables) db.exec(`DELETE FROM "${t.replaceAll('"', '""')}"`);
    if (hasSequence) db.exec('DELETE FROM sqlite_sequence');
  })();
  // Drop the freed pages too, so the old rows don't linger in the file or its WAL.
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
  return backup;
}
