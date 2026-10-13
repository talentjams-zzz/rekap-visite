"""Test: Tgl Reg is sortable by TIME as well as date.

The registry files carry a full registration timestamp ("YYYY-MM-DD HH:MM:SS")
in the "Tgl Registrasi" column. Before this feature the app stripped the time
(parseDate kept only the date), so sorting by Tgl Reg was date-only. Now:

  1. The full timestamp is stored in row.tglRegistrasi.
  2. The cell shows the date on line 1 and the time on line 2 (.tglreg-time).
  3. Sorting by Tgl Reg orders by date AND then by time (plain string compare
     on the fixed-format timestamp = chronological order).
  4. Date-only values (older data) still work: they sort as 00:00:00 of that
     day, and the Archived tab's date-range filter compares the date part only.

Drives the real app through a browser (same pattern as the other tests).
"""
import os, shutil, socket, subprocess, sys, tempfile, time
import openpyxl
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8801  # distinct from the pytest harness port (8765) and other live tests

def port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.25)
        return s.connect_ex(("127.0.0.1", port)) == 0

# ── 1. Throwaway master + synthetic registry file ─────────────────────────
tmpdir = tempfile.mkdtemp(prefix="rekap-tglreg-time-")
data_file = os.path.join(tmpdir, "master_data.json")

# Five patients: same-day different times, an earlier day, a later day, and
# one DATE-ONLY value (older data without a time).
#   ECHO    2026-09-19 07:00:00   <- latest day
#   ALPHA   2026-09-18 15:31:39
#   BRAVO   2026-09-18 08:15:00
#   DELTA   2026-09-18            <- date only (no time in source)
#   CHARLIE 2026-09-17 23:59:59   <- earliest
PATIENTS = [
    ("100001", "ALPHA",   "2026-09-18 15:31:39"),
    ("100002", "BRAVO",   "2026-09-18 08:15:00"),
    ("100003", "CHARLIE", "2026-09-17 23:59:59"),
    ("100004", "DELTA",   "2026-09-18"),
    ("100005", "ECHO",    "2026-09-19 07:00:00"),
]
wb = openpyxl.Workbook(); ws = wb.active
ws.append(["Daftar Pasien Rawat Inap"])
ws.append(["", "Tgl Registrasi", "No Registrasi", "Flag", "No. Rekam Medis", "EMR 2.1",
           "Nama Pasien", "Tgl Lahir", "Umur", "Dokter", "Dokter Tambahan", "Jenis Kelamin",
           "Tipe Pembayaran", "Jenis Peserta", "Kelas", "Kamar", "Bed", "Lama Rawat",
           "Kondisi Klinis", "Verif Farmasi"])
ws.append(["Ruangan Ruang Rawat Nusa Indah (Jumlah: 5)"])
for i, (mr, nama, tgl) in enumerate(PATIENTS, start=1):
    ws.append(["", tgl, str(900000000 + i), "", mr, "", nama,
               "01-01-1990", "36 thn", "dr. Test", "", "LAKI-LAKI", "BPJS", "PEKERJA MANDIRI",
               "Kelas III", f"10{i}", str(i), "", "HIJAU", "✘"])
syn_file = os.path.join(tmpdir, "nusin-19-09-26.xlsx")
wb.save(syn_file)
print("synthetic file:", os.path.basename(syn_file))

# ── 2. Start the server bound to the throwaway master ─────────────────────
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

        # Load the synthetic registry file.
        page.locator("#excelInput").set_input_files([syn_file])
        page.wait_for_timeout(2500)

        n = page.evaluate("rows.length")
        assert n == 5, f"expected 5 rows, got {n}"
        print(f"loaded synthetic file: {n} rows")

        # 1. Full timestamp stored (time kept, not stripped).
        stored = page.evaluate(
            "Object.fromEntries(rows.map(r => [r.mr, r.tglRegistrasi]))")
        for mr, nama, tgl in PATIENTS:
            assert stored[mr] == tgl, f"{nama}: stored {stored[mr]!r} != source {tgl!r}"
        print("1. Full timestamp stored in tglRegistrasi: OK")
        print("   ", stored)

        # 2. Cell shows date on line 1, time on line 2; date-only row has no time line.
        cells = page.evaluate("""
          (() => {
            const out = {};
            document.querySelectorAll("#tableWrap table.main-table tbody tr")
              .forEach(tr => {
                if (tr.classList.contains("history-row") || tr.classList.contains("lab-row")) return;
                const mr = tr.querySelector("td.mr-col");
                if (!mr) return;
                const td = tr.querySelector("td");
                const t = td.querySelector(".tglreg-time");
                out[mr.textContent.trim()] = {
                  date: t ? t.previousElementSibling.textContent : td.textContent.trim(),
                  time: t ? t.textContent : null
                };
              });
            return out;
          })()""")
        assert cells["100001"] == {"date": "2026-09-18", "time": "15:31:39"}, cells["100001"]
        assert cells["100005"] == {"date": "2026-09-19", "time": "07:00:00"}, cells["100005"]
        assert cells["100004"] == {"date": "2026-09-18", "time": None}, cells["100004"]
        print("2. Time displayed on a second line (date-only row unaffected): OK")

        # 3. Default sort (Tgl Reg desc) orders by date AND time.
        def visible_order():
            return page.evaluate("""
              Array.from(document.querySelectorAll("#tableWrap table.main-table tbody tr"))
                .filter(tr => !tr.classList.contains("history-row") && !tr.classList.contains("lab-row"))
                .map(tr => { const m = tr.querySelector("td.mr-col"); return m ? m.textContent.trim() : null; })
                .filter(Boolean)
            """)
        order = visible_order()
        assert order == ["100005", "100001", "100002", "100004", "100003"], \
            f"default desc order wrong: {order}"
        print("3. Default sort desc = date then time: OK  ->", order)

        # Sort cycle is asc -> desc -> default (default = Tgl Reg desc).
        # Tgl Reg is already the active desc column, so first move to another
        # column (MR), then click Tgl Reg -> asc: earliest first; date-only
        # sorts as 00:00:00.
        page.evaluate("sortRows('mr')")
        page.wait_for_timeout(300)
        page.evaluate("sortRows('tglRegistrasi')")
        page.wait_for_timeout(300)
        order = visible_order()
        assert order == ["100003", "100004", "100002", "100001", "100005"], \
            f"asc order wrong: {order}"
        print("4. Asc sort = date then time (date-only as 00:00:00): OK  ->", order)

        # Click again -> desc.
        page.evaluate("sortRows('tglRegistrasi')")
        page.wait_for_timeout(300)
        order = visible_order()
        assert order == ["100005", "100001", "100002", "100004", "100003"], \
            f"desc order wrong after toggle: {order}"
        print("5. Toggle back to desc: OK  ->", order)

        # Click a third time -> default (Tgl Reg desc) — order unchanged.
        page.evaluate("sortRows('tglRegistrasi')")
        page.wait_for_timeout(300)
        order = visible_order()
        assert order == ["100005", "100001", "100002", "100004", "100003"], \
            f"default reset order wrong: {order}"
        print("6. Third click resets to default (Tgl Reg desc): OK")

        # 6. Archived tab date-range filter compares the DATE part only:
        #    a row with tglRegistrasi "2026-09-18 15:31:39" must still match
        #    dateTo = 2026-09-18 (before the fix it was excluded, because
        #    "2026-09-18 15:31:39" > "2026-09-18").
        page.evaluate("toggleArchive('100001_nusin')")  # ALPHA
        page.wait_for_timeout(300)
        page.evaluate("switchTab('archived')")
        page.wait_for_timeout(300)
        def set_range(frm, to):
            page.evaluate("""(args) => {
              document.getElementById("archiveDateFrom").value = args.f;
              document.getElementById("archiveDateTo").value = args.t;
              render();
            }""", {"f": frm, "t": to})
            page.wait_for_timeout(200)
        set_range("2026-09-18", "2026-09-18")
        order = visible_order()
        assert order == ["100001"], f"boundary-day row missing from filter: {order}"
        print("7. Archive date filter keeps boundary-day row with time: OK")
        set_range("", "2026-09-17")
        order = visible_order()
        assert order == [], f"row should be filtered out: {order}"
        print("8. Archive date filter excludes later-day row: OK")

        assert errors == [], f"JS errors: {errors}"
        print("9. No JS errors: OK")
        browser.close()
finally:
    proc.terminate()
    try: proc.wait(timeout=5)
    except subprocess.TimeoutExpired: proc.kill()
    shutil.rmtree(tmpdir, ignore_errors=True)

print("\nCONCLUSION: Tgl Reg is sortable by time as well as date.")
