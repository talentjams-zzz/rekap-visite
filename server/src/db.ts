import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function openDb(file: string): DatabaseSync {
  // A fresh checkout has no data/ dir (gitignored) — create the parent so a
  // first `pm2 start` doesn't crash with "unable to open database file".
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  const schema = readFileSync(path.join(here, '..', 'schema.sql'), 'utf8');
  db.exec(schema);
  // Lightweight column upgrades for databases created before a column existed
  // (CREATE TABLE IF NOT EXISTS does not add columns to existing tables).
  const cols = db.prepare("PRAGMA table_info('patients')").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'aso_json')) {
    db.exec("ALTER TABLE patients ADD COLUMN aso_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!cols.some((c) => c.name === 'rev')) {
    db.exec('ALTER TABLE patients ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
  }
  return db;
}
