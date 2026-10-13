"""Live test: does the REAL master_data.json need migration for PIO?

Loads the actual 358-row master (from a COPY — the real file is never touched)
into the app via the server, then:
  1. Confirms the PIO checkbox renders on a PRE-EXISTING row (one that has no
     checklist.pio / pioLog key at all — the real-world state).
  2. Checks PIO on that row → works, no JS error.
  3. Loads a synthetic NEWER-day registry file containing that patient → the
     daily reset fires: PIO is cleared and archived into row.pioLog.
  4. Confirms the Rekap tab still shows the archived PIO work.

If all of this passes on un-migrated real data, no migration is needed.
"""
import datetime as dt
import json, os, shutil, socket, subprocess, sys, tempfile, time
import openpyxl
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REAL = os.path.join(HERE, "master_data.json")
PORT = 8799  # distinct from the pytest harness port (8765)

def port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.25)
        return s.connect_ex(("127.0.0.1", port)) == 0

# ── 1. Copy the real master to a throwaway DATA_FILE ──────────────────────
tmpdir = tempfile.mkdtemp(prefix="rekap-pio-real-")
data_file = os.path.join(tmpdir, "master_data.json")
shutil.copyfile(REAL, data_file)
with open(data_file) as f:
    real = json.load(f)
rows = real["rows"]
active = [r for r in rows if not r.get("archived")]
target = max(active, key=lambda r: r["dateAdded"])
MR = target["mr"]; FAC = target["facility"]; ID = target["id"]
print(f"target pre-existing row: {ID} (MR {MR}, {FAC}, dateAdded {target['dateAdded']})")
print(f"  has checklist.pio? {'pio' in (target.get('checklist') or {})}  has pioLog? {'pioLog' in target}")

# ── 2. Build a synthetic NEWER-day registry file containing that patient ──
# Newer than the real max dateAdded so the daily reset actually fires.
# (Computed dynamically: the real data advances over time, and a same-day
# re-import is idempotent — it would NOT fire the reset.)
max_date = max(r["dateAdded"] for r in rows if r.get("dateAdded"))
new_day = (dt.date.fromisoformat(max_date) + dt.timedelta(days=1)).isoformat()
new_day_name = f"{new_day[8:10]}-{new_day[5:7]}-{new_day[2:4]}"  # DD-MM-YY for the filename
wb = openpyxl.Workbook(); ws = wb.active
ws.append(["Daftar Pasien Rawat Inap"])
ws.append(["", "Tgl Registrasi", "No Registrasi", "Flag", "No. Rekam Medis", "EMR 2.1",
           "Nama Pasien", "Tgl Lahir", "Umur", "Dokter", "Dokter Tambahan", "Jenis Kelamin",
           "Tipe Pembayaran", "Jenis Peserta", "Kelas", "Kamar", "Bed", "Lama Rawat",
           "Kondisi Klinis", "Verif Farmasi"])
ws.append(["Ruangan Ruang Rawat Inap"])
ws.append(["", f"{new_day} 08:00:00", "9999999999", "", MR, "", target.get("nama", "TEST"),
           "01-01-1990", "36 thn", "dr. Test", "", "LAKI-LAKI", "BPJS", "PEKERJA MANDIRI",
           "Kelas III", target.get("kamar", "100"), target.get("bed", "1"), "", "HIJAU", "✘"])
syn_file = os.path.join(tmpdir, f"{FAC}-{new_day_name}.xlsx")
wb.save(syn_file)
print("synthetic newer-day file:", os.path.basename(syn_file))

# ── 3. Start the server bound to the copy ─────────────────────────────────
env = dict(os.environ, DATA_FILE=data_file)
proc = subprocess.Popen(["node", "server.js", str(PORT)], cwd=HERE, env=env,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    deadline = time.time() + 15
    while time.time() < deadline:
        if port_open(PORT): break
        if proc.poll() is not None: raise RuntimeError("server exited early")
        time.sleep(0.1)
    else:
        raise RuntimeError("server did not open in time")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"http://localhost:{PORT}/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(800)

        # Loaded the real data?
        n = page.evaluate("rows.length")
        assert n == len(rows), f"expected {len(rows)} rows, got {n}"
        print(f"loaded real master: {n} rows")

        # 1. PIO checkbox renders on the pre-existing (un-migrated) row.
        page.evaluate(f"switchTab('{FAC}')")
        page.wait_for_timeout(300)
        labels = page.evaluate(
            "Array.from(document.querySelectorAll('#tableWrap .cl-item label')).map(l=>l.textContent.trim())")
        assert "PIO" in labels, f"PIO checkbox not rendered on real data: {labels[:10]}"
        print("1. PIO checkbox renders on pre-existing rows: OK")

        # 2. Check PIO on the target row → works, no error.
        page.evaluate(f"toggleRowCheck('{ID}','pio')")
        page.wait_for_timeout(200)
        pio = page.evaluate(f"rows.find(r=>r.id==='{ID}').checklist.pio")
        assert pio, f"PIO not set on pre-existing row: {pio}"
        print(f"2. PIO set on pre-existing row: OK ({pio})")

        # 3. Load the synthetic newer-day file → daily reset fires.
        page.locator("#excelInput").set_input_files([syn_file])
        page.wait_for_timeout(2500)
        st = page.evaluate(f"""({{
          pio: rows.find(r=>r.id==='{ID}').checklist.pio,
          pioLog: rows.find(r=>r.id==='{ID}').pioLog,
          dateAdded: rows.find(r=>r.id==='{ID}').dateAdded
        }})""")
        assert st["dateAdded"] == new_day, f"date did not advance: {st['dateAdded']}"
        assert st["pio"] is None, f"PIO not cleared on new day: {st['pio']}"
        assert st["pioLog"] and len(st["pioLog"]) == 1, f"pioLog not populated: {st['pioLog']}"
        print(f"3. Daily reset on real data: OK (cleared, archived to pioLog: {st['pioLog']})")

        # 4. Rekap still shows the archived PIO work.
        page.locator("#tab_rekap").click()
        page.wait_for_timeout(300)
        rekap = page.evaluate("""
          (() => { const r = buildRekapData(); const d = {};
            Object.keys(r).forEach(k => { if (r[k].pio) d[k] = r[k].pio.mrs; }); return d; })()
        """)
        assert any(MR in v for v in rekap.values()), f"archived PIO missing from rekap: {rekap}"
        print(f"4. Rekap shows archived PIO: OK ({rekap})")

        assert errors == [], f"JS errors on real data: {errors}"
        print("5. No JS errors on un-migrated real data: OK")
        browser.close()
finally:
    proc.terminate()
    try: proc.wait(timeout=5)
    except subprocess.TimeoutExpired: proc.kill()
    shutil.rmtree(tmpdir, ignore_errors=True)

print("\nCONCLUSION: real master_data.json needs NO migration — PIO works on un-migrated rows.")
