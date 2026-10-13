import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { db, dbPath } from '../../server/db';
import { backupDatabase, replaceDatabase, validateDatabase } from '../../server/maintenance';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-maint-'));
const accountCount = (file: string) => {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return (d.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  } finally {
    d.close();
  }
};

describe('database backup and import', () => {
  it('backs up the live database to a single file, even with a quote in the path', () => {
    db.prepare("INSERT INTO accounts (name) VALUES ('Savings')").run();
    const dest = path.join(tmp, "Shay's backup.db");
    backupDatabase(dest);
    expect(accountCount(dest)).toBe(1);
    expect(() => validateDatabase(dest)).not.toThrow();
  });

  it('rejects files that are not Finance Dashboard databases', () => {
    const junk = path.join(tmp, 'junk.db');
    fs.writeFileSync(junk, 'not sqlite at all, just some text that is long enough to not be empty');
    expect(() => validateDatabase(junk)).toThrow('Not a readable SQLite database');

    const other = path.join(tmp, 'other.db');
    const d = new DatabaseSync(other);
    d.exec('CREATE TABLE notes (x)');
    d.close();
    expect(() => validateDatabase(other)).toThrow('not created by Finance Dashboard');
  });

  // Runs last: it closes the live connection, as the desktop app restarts afterwards.
  it('replaces the live database, including rows only in the source WAL, and keeps a backup', () => {
    const src = path.join(tmp, 'incoming.db');
    backupDatabase(src);
    const writer = new DatabaseSync(src);
    writer.exec('PRAGMA journal_mode = WAL');
    writer.exec('PRAGMA wal_autocheckpoint = 0');
    writer.exec("INSERT INTO accounts (name) VALUES ('Only in WAL')");
    // Copy while the WAL is un-checkpointed, as a copied dev database would be.
    for (const s of ['', '-wal']) fs.copyFileSync(src + s, path.join(tmp, 'copy.db' + s));
    writer.close();

    const backup = replaceDatabase(path.join(tmp, 'copy.db'));
    expect(accountCount(backup)).toBe(1);
    expect(accountCount(dbPath)).toBe(2);
  });
});
