#!/usr/bin/env node
// Rekap Visite — tiny zero-dependency server (Node built-ins only).
//
// Serves the app (index.html + xlsx.full.min.js) and stores the master JSON
// with optimistic-concurrency versioning + Server-Sent Events for live sync.
//
//   GET  /               -> index.html
//   GET  <static file>   -> any file in this folder (xlsx.full.min.js, ...)
//   GET  /api/health     -> { ok, version, clients }
//   GET  /api/master     -> { data, version }
//   PUT  /api/master     -> body { data, baseVersion }
//                            200 { ok:true, version }
//                            409 { ok:false, error:'conflict', current, currentVersion }
//   GET  /api/events     -> SSE stream; broadcasts { version } after every save
//   GET  /api/maintenance    -> { ok, enabled, time, lastMaintenance }
//   POST /api/maintenance/run -> run the monthly job now (backup + cleanup)
//
// Monthly maintenance (built-in, no cron needed):
//   On the 1st of each month at MONTHLY_CLEANUP_TIME (local, default 00:05)
//   the server: (1) writes a full timestamped backup of the data file next
//   to it, (2) verifies the backup (parse + row count), and (3) only then
//   removes all archived rows plus orphaned per-MR checklist/lab data.
//   It runs ONLY at that scheduled moment while the server is up — a
//   first-time or mid-month startup never triggers it. If the server is
//   down on the 1st, that month's run is skipped (use the manual button).
//   The run is recorded in the data file's `lastMaintenance` field, which
//   client saves preserve.
//
// Run:   node server.js [port]        (default 8787)
// Env:   HOST (default 0.0.0.0), PORT (default 8787),
//        MONTHLY_CLEANUP (default 1; 0 disables the automatic job),
//        MONTHLY_CLEANUP_TIME (default "00:05", local HH:MM),
//        MONTHLY_CLEANUP_DAY (default 1, day of month)
// Data:  master_data.json next to this file (created on first save).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
// DATA_FILE env var lets the test harness (conftest.py) point the server at a
// throwaway file so tests never touch the real master_data.json. Defaults to
// the real file next to this script when the env var is not set.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'master_data.json');

// ── monthly maintenance config ─────────────────────────────────────────
// On the 1st of each month at CLEANUP_TIME (local): back up the whole data
// file, verify the backup, then remove all archived rows + orphaned per-MR
// data. Scheduled only — a first-time or mid-month startup never triggers it.
const CLEANUP_ENABLED = (process.env.MONTHLY_CLEANUP || '1') !== '0';
const CLEANUP_TIME = process.env.MONTHLY_CLEANUP_TIME || '00:05'; // "HH:MM" local
const CLEANUP_DAY = parseInt(process.env.MONTHLY_CLEANUP_DAY || '1', 10); // day of month

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

// ── state ──────────────────────────────────────────────────────────────
let version = 0;                 // authoritative in-memory version
let writeChain = Promise.resolve(); // serializes writes (no lost updates)
const sseClients = new Set();

// Load the persisted version once at startup.
try {
  const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  version = typeof j.version === 'number' ? j.version : 0;
} catch (e) { version = 0; }

function readData() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    delete j.version; // version travels separately, not inside data
    return j;
  } catch (e) {
    return { savedAt: null, rows: [], patientChecklist: {}, labResults: {}, facilityLatestInput: {}, colWidths: {} };
  }
}

function broadcast(obj) {
  const msg = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of sseClients) { try { res.write(msg); } catch (e) {} }
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ── monthly maintenance: backup first, then remove archived patients ───
// The server is the only writer of the `lastMaintenance` field; client saves
// (PUT /api/master) preserve whatever is already in the file.
let maintenanceRunning = false;
let skippedMonth = null; // month key the job skipped (no data file yet)

function pad2(n) { return String(n).padStart(2, '0'); }
function localStamp(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function monthKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
function hhmm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

function readLastMaintenance() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).lastMaintenance || null; }
  catch (e) { return null; }
}

// Due ONLY at the scheduled moment: the 1st of the month at/after
// CLEANUP_TIME, once per month. A first-time or mid-month startup never
// triggers the job (the manual button still works).
function cleanupDue(now, lastMaintenance) {
  if (!CLEANUP_ENABLED) return false;
  if (skippedMonth === monthKey(now)) return false;
  if (lastMaintenance && typeof lastMaintenance.ranAt === 'string' &&
      lastMaintenance.ranAt.slice(0, 7) === monthKey(now)) return false;
  if (now.getDate() !== CLEANUP_DAY) return false;
  if (hhmm(now) < CLEANUP_TIME) return false;
  return true;
}

function runMonthlyMaintenance(trigger) {
  if (maintenanceRunning) return { ok: false, error: 'maintenance already running' };
  maintenanceRunning = true;
  try {
    let raw;
    try { raw = fs.readFileSync(DATA_FILE, 'utf8'); }
    catch (e) {
      skippedMonth = monthKey(new Date());
      return { ok: true, skipped: true, reason: 'no data file yet' };
    }
    const current = JSON.parse(raw);
    const rowsBefore = Array.isArray(current.rows) ? current.rows.length : 0;
    const sizeBefore = Buffer.byteLength(raw);

    // 1) BACKUP FIRST — full copy of the live file, same naming as the
    //    frontend's Export Snapshot, written next to the data file.
    const now = new Date();
    const backupName = 'rekap-visite-master-' + now.getFullYear() + '-' + pad2(now.getMonth() + 1) +
      '-' + pad2(now.getDate()) + '-' + pad2(now.getHours()) + '-' + pad2(now.getMinutes()) +
      '-' + pad2(now.getSeconds()) + '.json';
    const backupPath = path.join(path.dirname(DATA_FILE), backupName);
    fs.writeFileSync(backupPath, raw);

    // 2) VERIFY the backup before touching the live data.
    const check = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    if (!check || !Array.isArray(check.rows) || check.rows.length !== rowsBefore) {
      throw new Error('backup verification failed — nothing was removed');
    }

    // 3) REMOVE archived rows + orphaned per-MR data (safe: backup verified).
    const rows = current.rows.filter(r => !r.archived);
    const remainingMRs = new Set(rows.map(r => String(r.mr)));
    const pc = current.patientChecklist || {};
    const lr = current.labResults || {};
    const patientChecklist = {}, labResults = {};
    for (const k of Object.keys(pc)) if (remainingMRs.has(String(k))) patientChecklist[k] = pc[k];
    for (const k of Object.keys(lr)) if (remainingMRs.has(String(k))) labResults[k] = lr[k];

    const lastMaintenance = {
      ranAt: localStamp(now),
      trigger,
      backupFile: backupName,
      rowsBefore,
      rowsAfter: rows.length,
      removedRows: rowsBefore - rows.length,
      removedChecklist: Object.keys(pc).length - Object.keys(patientChecklist).length,
      removedLab: Object.keys(lr).length - Object.keys(labResults).length,
      sizeBefore,
      sizeAfter: null,
    };

    const toWrite = Object.assign({}, current, {
      rows, patientChecklist, labResults, lastMaintenance, version: version + 1,
    });
    // Serialize until sizeAfter (the serialized length) is self-consistent:
    // the value's own digit count affects the length, so re-measure once set.
    let text = JSON.stringify(toWrite, null, 2);
    for (let i = 0; i < 5; i++) {
      lastMaintenance.sizeAfter = Buffer.byteLength(text);
      const next = JSON.stringify(toWrite, null, 2);
      if (next === text) break;
      text = next;
    }

    // Atomic write: temp file + rename, so a crash never leaves a half file.
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, DATA_FILE);
    version += 1;
    broadcast({ version });
    console.log('[maintenance] ' + trigger + ': backup ' + backupName + ' verified; removed ' +
      lastMaintenance.removedRows + ' archived rows, ' + lastMaintenance.removedChecklist +
      ' checklist entries, ' + lastMaintenance.removedLab + ' lab results (' +
      sizeBefore + ' B -> ' + lastMaintenance.sizeAfter + ' B)');
    return { ok: true, lastMaintenance };
  } catch (err) {
    console.error('[maintenance] FAILED: ' + err.message);
    return { ok: false, error: err.message };
  } finally {
    maintenanceRunning = false;
  }
}

function maybeRunMaintenance() {
  const now = new Date();
  if (!cleanupDue(now, readLastMaintenance())) return;
  runMonthlyMaintenance('scheduled');
}

// ── request handler ────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { res.writeHead(400); return res.end('bad request'); }
  const p = url.pathname;

  // ── API ──
  if (p === '/api/health' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, version, clients: sseClients.size });
  }

  if (p === '/api/master' && req.method === 'GET') {
    return sendJSON(res, 200, { data: readData(), version });
  }

  if (p === '/api/master' && req.method === 'PUT') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      writeChain = writeChain.then(() => {
        let payload;
        try { payload = JSON.parse(body); }
        catch (e) { return sendJSON(res, 400, { ok: false, error: 'invalid JSON' }); }
        const data = payload && payload.data;
        const baseVersion = payload && payload.baseVersion;
        if (!data || typeof data !== 'object') return sendJSON(res, 400, { ok: false, error: 'missing data' });
        if (baseVersion !== version) {
          return sendJSON(res, 409, { ok: false, error: 'conflict', current: readData(), currentVersion: version });
        }
        version = baseVersion + 1;
        const toWrite = Object.assign({}, data, { version });
        // Preserve the server-owned maintenance log across client saves
        // (clients don't send it back — see runMonthlyMaintenance).
        try {
          const lm = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).lastMaintenance;
          if (lm) toWrite.lastMaintenance = lm;
        } catch (e) {}
        fs.writeFile(DATA_FILE, JSON.stringify(toWrite, null, 2), (err) => {
          if (err) return sendJSON(res, 500, { ok: false, error: 'write failed: ' + err.message });
          broadcast({ version });
          sendJSON(res, 200, { ok: true, version });
        });
      }).catch(err => sendJSON(res, 500, { ok: false, error: err.message }));
    });
    return;
  }

  if (p === '/api/maintenance' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, enabled: CLEANUP_ENABLED, time: CLEANUP_TIME, lastMaintenance: readLastMaintenance() });
  }

  if (p === '/api/maintenance/run' && req.method === 'POST') {
    const j = runMonthlyMaintenance('manual');
    return sendJSON(res, j.ok ? 200 : 500, j);
  }

  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
    return;
  }

  // ── static files ──
  if (req.method === 'GET') {
    let rel = p === '/' ? '/index.html' : p;
    const abs = path.normalize(path.join(__dirname, rel));
    if (!abs.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
    fs.stat(abs, (statErr, stat) => {
      if (statErr) { res.writeHead(404); return res.end('not found'); }
      fs.readFile(abs, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        const ext = path.extname(abs).toLowerCase();
        const isHtml = ext === '.html';
        // HTML must NEVER be cached: the app is a single index.html that gets
        // edited in place, and a stale cached copy silently runs old code
        // (e.g. a bug that was already fixed on disk). no-store forces a
        // fresh fetch on every load.
        // Other assets (xlsx.full.min.js, images) are immutable-ish, so give
        // them an ETag + Last-Modified and let the browser revalidate (304)
        // instead of re-downloading.
        const etag = '"' + stat.size + '-' + stat.mtimeMs.toFixed(0) + '"';
        const headers = {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'ETag': etag,
          'Last-Modified': stat.mtime.toUTCString(),
        };
        if (isHtml) {
          headers['Cache-Control'] = 'no-store';
        } else {
          headers['Cache-Control'] = 'no-cache'; // revalidate, don't use stale
        }
        // 304 Not Modified: browser already has a matching copy.
        if (!isHtml && req.headers['if-none-match'] === etag) {
          res.writeHead(304, headers);
          return res.end();
        }
        res.writeHead(200, headers);
        res.end(buf);
      });
    });
    return;
  }

  res.writeHead(405); res.end('method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log('Rekap Visite server: http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log('Data file: ' + DATA_FILE);
  console.log('Monthly maintenance: ' + (CLEANUP_ENABLED ? 'on (day ' + CLEANUP_DAY + ' of month at ' + CLEANUP_TIME + ' local, scheduled only)' : 'disabled (MONTHLY_CLEANUP=0)'));
});

// Monthly maintenance: check every minute; the first check (5 s after start)
// covers a server that starts on the scheduled day after the scheduled time.
setTimeout(maybeRunMaintenance, 5000);
setInterval(maybeRunMaintenance, 60 * 1000);
