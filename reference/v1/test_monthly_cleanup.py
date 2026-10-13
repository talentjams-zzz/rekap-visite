"""Verify: monthly maintenance job (backup first, then remove archived patients).

The server runs a built-in monthly job (no cron): on the 1st of each month at
00:05 local (or on demand via POST /api/maintenance/run / the 🧹 button). It
runs ONLY at that scheduled moment — a first-time or mid-month startup never
triggers it:
  1. writes a full timestamped backup of the data file next to it
  2. verifies the backup (parse + row count)
  3. only then removes all archived rows + orphaned per-MR checklist/lab data
  4. records the run in the data file's `lastMaintenance` field, which client
     saves preserve

This test uses its OWN server instances (ports 8766/8767, throwaway data
files) so it never touches the shared session server or the real
master_data.json.
"""
import atexit
import datetime as dt
import glob
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

from conftest import HERE  # noqa: E402

PORT = 8766
CATCHUP_PORT = 8767


def _port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.25)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _free_port(want):
    p = want
    while _port_open(p):
        p += 1
    return p


def _start(port, data_file, extra_env=None):
    env = dict(os.environ, DATA_FILE=data_file)
    if extra_env:
        env.update(extra_env)
    proc = subprocess.Popen(
        ["node", "server.js", str(port)],
        cwd=HERE,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 15
    while time.time() < deadline:
        if _port_open(port):
            return proc
        if proc.poll() is not None:
            raise RuntimeError("server.js exited early during test setup")
        time.sleep(0.1)
    raise RuntimeError(f"server.js did not open port {port} in time")


def _stop(proc):
    if proc is None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def api(base, method, path, body=None):
    req = urllib.request.Request(base + path, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data) as r:
        return json.loads(r.read().decode())


def seed_file(dirpath, last_maintenance_ran_at):
    """Write a data file: 2 active + 2 archived rows, per-MR checklist/lab data."""
    data = {
        "savedAt": "2026-09-28T08:00:00.000Z",
        "rows": [
            {"id": "1001_nusin", "mr": "1001", "facility": "nusin", "dateAdded": "2026-09-28",
             "lastSeen": "2026-09-28 08:00:00", "nama": "ACTIVE ONE", "archived": False,
             "archivedAt": None, "checklist": {}, "telaahLog": [], "history": []},
            {"id": "1002_melati", "mr": "1002", "facility": "melati", "dateAdded": "2026-09-28",
             "lastSeen": "2026-09-28 08:00:00", "nama": "ACTIVE TWO", "archived": False,
             "archivedAt": None, "checklist": {}, "telaahLog": [], "history": []},
            {"id": "2001_nusin", "mr": "2001", "facility": "nusin", "dateAdded": "2026-09-20",
             "lastSeen": "2026-09-20 08:00:00", "nama": "ARCHIVED ONE", "archived": True,
             "archivedAt": "2026-09-28 08:00:00", "checklist": {}, "telaahLog": [], "history": []},
            {"id": "2002_sakura", "mr": "2002", "facility": "sakura", "dateAdded": "2026-09-19",
             "lastSeen": "2026-09-19 08:00:00", "nama": "ARCHIVED TWO", "archived": True,
             "archivedAt": "2026-09-28 08:00:00", "checklist": {}, "telaahLog": [], "history": []},
        ],
        "patientChecklist": {
            "1001": {"visite": "2026-09-28 09:00:00"},
            "1002": {"visite": None},
            "2001": {"visite": "2026-09-20 09:00:00"},
            "2002": {"pto": "2026-09-19 09:00:00"},
        },
        "labResults": {
            "1001": {"loadedAt": "2026-09-28 10:00:00", "tests": [{"nama": "Hemoglobin"}]},
            "2001": {"loadedAt": "2026-09-20 10:00:00", "tests": [{"nama": "Hemoglobin"}]},
            "2002": {"loadedAt": "2026-09-19 10:00:00", "tests": [{"nama": "WBC"}]},
        },
        "facilityLatestInput": {"nusin": "2026-09-28 08:00:00", "melati": "2026-09-28 08:00:00",
                               "sakura": "2026-09-19 08:00:00"},
        "colWidths": {},
        "version": 7,
    }
    if last_maintenance_ran_at:
        data["lastMaintenance"] = {
            "ranAt": last_maintenance_ran_at, "trigger": "scheduled",
            "backupFile": "rekap-visite-master-earlier.json",
            "rowsBefore": 4, "rowsAfter": 2, "removedRows": 2,
            "removedChecklist": 2, "removedLab": 2, "sizeBefore": 1, "sizeAfter": 1,
        }
    p = os.path.join(dirpath, "master_data.json")
    with open(p, "w") as f:
        json.dump(data, f, indent=2)
    return p


def test_main():
    """Run the verification script body."""
    out = {}

    # ── dedicated server for the API tests ─────────────────────────────
    # Seed lastMaintenance with THIS month so the startup catch-up does not
    # fire mid-test (the job "already ran this month").
    tmp1 = tempfile.mkdtemp(prefix="rekap-cleanup-")
    seed_file(tmp1, dt.date.today().replace(day=1).strftime("%Y-%m-01 00:05:00"))
    port1 = _free_port(PORT)
    proc1 = _start(port1, os.path.join(tmp1, "master_data.json"))
    atexit.register(_stop, proc1)
    base1 = f"http://localhost:{port1}"

    # 1. Maintenance status before the run (seeded: already ran this month).
    out["maintenance_before"] = api(base1, "GET", "/api/maintenance")

    # 2. Manual run: backup first, then remove archived rows + orphaned data.
    out["run1"] = api(base1, "POST", "/api/maintenance/run")

    # 3. Verify the backup file: full copy (4 rows incl. archived), old version.
    lm = out["run1"]["lastMaintenance"]
    with open(os.path.join(tmp1, lm["backupFile"])) as f:
        backup = json.load(f)
    out["backup"] = {
        "rows": len(backup["rows"]),
        "has_archived": any(r["archived"] for r in backup["rows"]),
        "version": backup.get("version"),
        "checklist_keys": sorted(backup["patientChecklist"].keys()),
        "lab_keys": sorted(backup["labResults"].keys()),
    }

    # 4. Live data: only active rows remain; orphaned per-MR data removed.
    j = api(base1, "GET", "/api/master")
    out["after_run1"] = {
        "rows": sorted(r["mr"] for r in j["data"]["rows"]),
        "checklist_keys": sorted(j["data"]["patientChecklist"].keys()),
        "lab_keys": sorted(j["data"]["labResults"].keys()),
        "lastMaintenance": j["data"]["lastMaintenance"],
        "version": j["version"],
    }

    # 5. Client save (no lastMaintenance in payload) must PRESERVE the log.
    j2 = api(base1, "GET", "/api/master")
    payload = j2["data"]
    payload.pop("lastMaintenance", None)
    payload["rows"][0]["nama"] = "ACTIVE ONE EDITED"
    out["client_save"] = api(base1, "PUT", "/api/master",
                             {"data": payload, "baseVersion": j2["version"]})
    with open(os.path.join(tmp1, "master_data.json")) as f:
        raw = json.load(f)
    out["lm_preserved_after_client_save"] = (raw.get("lastMaintenance") or {}).get("backupFile")

    # 6. Second run: nothing archived left -> removedRows 0, new backup written.
    time.sleep(1.1)  # backup names carry seconds; make the second name distinct
    out["run2"] = api(base1, "POST", "/api/maintenance/run")
    out["backups_on_disk"] = sorted(os.path.basename(p)
                                    for p in glob.glob(os.path.join(tmp1, "rekap-visite-master-*.json")))

    # 7. Scheduled-only: a FIRST-TIME / mid-month startup must NOT auto-run.
    #    (Day knob set to a day that is NOT today so the test is deterministic
    #    even if it happens to run on the 1st.)
    today = dt.date.today()
    not_today = 2 if today.day == 1 else 1
    tmp2 = tempfile.mkdtemp(prefix="rekap-norun-")
    seed_file(tmp2, None)  # first-time startup: no lastMaintenance at all
    port2 = _free_port(CATCHUP_PORT)
    proc2 = _start(port2, os.path.join(tmp2, "master_data.json"),
                   extra_env={"MONTHLY_CLEANUP_DAY": str(not_today)})
    atexit.register(_stop, proc2)
    base2 = f"http://localhost:{port2}"
    time.sleep(8)  # well past the 5 s startup check
    m2 = api(base2, "GET", "/api/maintenance")
    with open(os.path.join(tmp2, "master_data.json")) as f:
        raw2 = json.load(f)
    out["no_auto_run_on_startup"] = {
        "lastMaintenance": m2.get("lastMaintenance"),
        "live_rows": len(raw2["rows"]),
        "backups_on_disk": sorted(os.path.basename(p)
                                  for p in glob.glob(os.path.join(tmp2, "rekap-visite-master-*.json"))),
    }
    _stop(proc2)

    # 8. Scheduled run: on the scheduled day (knob = today) at/after the
    #    scheduled time, the job runs automatically — even on first startup.
    tmp3 = tempfile.mkdtemp(prefix="rekap-sched-")
    seed_file(tmp3, None)
    port3 = _free_port(CATCHUP_PORT + 1)
    proc3 = _start(port3, os.path.join(tmp3, "master_data.json"),
                   extra_env={"MONTHLY_CLEANUP_DAY": str(today.day),
                              "MONTHLY_CLEANUP_TIME": "00:00"})
    atexit.register(_stop, proc3)
    base3 = f"http://localhost:{port3}"
    deadline = time.time() + 30
    ran = None
    while time.time() < deadline:
        m3 = api(base3, "GET", "/api/maintenance")
        lm3 = m3.get("lastMaintenance") or {}
        if lm3.get("ranAt", "").startswith(today.strftime("%Y-%m")):
            ran = lm3
            break
        time.sleep(0.5)
    with open(os.path.join(tmp3, "master_data.json")) as f:
        raw3 = json.load(f)
    out["scheduled_run"] = {
        "ran": ran is not None,
        "lastMaintenance": ran,
        "live_rows": sorted(r["mr"] for r in raw3["rows"]),
        "backups_on_disk": sorted(os.path.basename(p)
                                  for p in glob.glob(os.path.join(tmp3, "rekap-visite-master-*.json"))),
    }
    _stop(proc3)

    # 9. Browser: 🧹 button + confirm + badge (server mode).
    j3 = api(base1, "GET", "/api/master")
    j3["data"]["rows"].append({
        "id": "3001_observasi", "mr": "3001", "facility": "observasi", "dateAdded": "2026-09-27",
        "lastSeen": "2026-09-27 08:00:00", "nama": "ARCHIVED THREE", "archived": True,
        "archivedAt": "2026-09-28 08:00:00", "checklist": {}, "telaahLog": [], "history": [],
    })
    api(base1, "PUT", "/api/master", {"data": j3["data"], "baseVersion": j3["version"]})

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        dialogs = []
        page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
        page.goto(base1 + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(800)

        out["browser"] = {
            "button_visible": page.locator("#cleanupBtn").is_visible(),
            "badge_visible_before": page.locator("#cleanupBadge").is_visible(),
            "badge_text_before": page.locator("#cleanupBadge").inner_text(),
        }
        page.click("#cleanupBtn")
        # The badge flips to "1 removed" once the reloaded data lands (the SSE
        # broadcast and the button's own reload both converge on it).
        page.wait_for_function(
            "document.getElementById('cleanupBadge').textContent.includes('1 removed')",
            timeout=15000)
        page.wait_for_timeout(300)
        out["browser"]["dialog"] = dialogs[0] if dialogs else None
        out["browser"]["badge_text_after"] = page.locator("#cleanupBadge").inner_text()
        out["browser"]["archived_left"] = page.evaluate("rows.filter(r=>r.archived).length")
        out["browser"]["js_errors"] = errors
        browser.close()

    _stop(proc1)
    _stop(proc2)

    # ── hard assertions ──────────────────────────────────────────────────
    assert out["run1"]["ok"] is True
    assert out["run1"]["lastMaintenance"]["removedRows"] == 2
    assert out["run1"]["lastMaintenance"]["sizeAfter"] is not None
    assert out["backup"]["rows"] == 4 and out["backup"]["has_archived"] is True
    assert out["backup"]["version"] == 7  # full copy of the pre-cleanup file
    assert out["after_run1"]["rows"] == ["1001", "1002"]
    assert out["after_run1"]["checklist_keys"] == ["1001", "1002"]
    assert out["after_run1"]["lab_keys"] == ["1001"]
    assert out["after_run1"]["version"] == 8
    assert out["lm_preserved_after_client_save"] == out["run1"]["lastMaintenance"]["backupFile"]
    assert out["run2"]["lastMaintenance"]["removedRows"] == 0
    assert len(out["backups_on_disk"]) == 2
    assert out["no_auto_run_on_startup"]["lastMaintenance"] is None
    assert out["no_auto_run_on_startup"]["live_rows"] == 4  # archived rows untouched
    assert out["no_auto_run_on_startup"]["backups_on_disk"] == []
    assert out["scheduled_run"]["ran"] is True
    assert out["scheduled_run"]["lastMaintenance"]["trigger"] == "scheduled"
    assert out["scheduled_run"]["live_rows"] == ["1001", "1002"]
    assert len(out["scheduled_run"]["backups_on_disk"]) == 1
    assert out["browser"]["button_visible"] is True
    assert out["browser"]["badge_visible_before"] is True
    assert "Remove 1 archived patient" in out["browser"]["dialog"]
    assert out["browser"]["badge_text_after"].endswith("1 removed")
    assert out["browser"]["archived_left"] == 0
    assert out["browser"]["js_errors"] == []

    print(json.dumps(out, indent=2, ensure_ascii=False))
