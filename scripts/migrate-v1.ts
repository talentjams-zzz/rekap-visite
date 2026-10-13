#!/usr/bin/env node
// CLI: v1 master_data.json -> v2 SQLite (data/rekap.db).
// Run: node scripts/migrate-v1.ts [--force]
// Env: REKAP_MASTER (default ./master_data.json), REKAP_DB (default ./data/rekap.db)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigration } from '../server/src/migrate.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcFile = process.env.REKAP_MASTER || path.join(root, 'master_data.json');
const dbFile = process.env.REKAP_DB || path.join(root, 'data', 'rekap.db');
const force = process.argv.includes('--force');

let src;
try {
  src = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
} catch (e) {
  console.error(`Failed to read/parse ${srcFile}: ${(e as Error).message}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const tableExists =
  (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'patients' AND type = 'table'").get() as { c: number }).c > 0;
if (tableExists) {
  const n = (db.prepare('SELECT COUNT(*) c FROM patients').get() as { c: number }).c;
  if (n > 0 && !force) {
    console.error(`DB already contains ${n} patients. Re-run with --force to wipe and re-migrate.`);
    process.exit(1);
  }
}

const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
const report = runMigration(db, src, schema);

for (const c of report.checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: got ${c.got}, want ${c.want}`);
}
console.log(report.ok ? '\n✓ Migration verified OK' : '\n✗ MISMATCH — see above');
process.exit(report.ok ? 0 : 1);
