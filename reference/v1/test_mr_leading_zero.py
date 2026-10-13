"""Regression test: a numeric MEDREC (leading zero dropped by Excel) must merge
into the existing zero-padded row, NOT create a duplicate.

This is the root cause of "operan sometimes doesn't update": Excel exports the
MEDREC as a number in some files, so 067016 becomes 67016. Before the fix the
merge keyed on the exact MR string, so 67016_nusin != 067016_nusin — a duplicate
row was created (auto-archived) and the patient kept showing the old operan.

Run:  python3 -m pytest test_mr_leading_zero.py -v
"""
import os, shutil, socket, subprocess, tempfile, time
import openpyxl
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8810

def port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.25)
        return s.connect_ex(("127.0.0.1", port)) == 0

def make_registry(path, mr, nama):
    wb = openpyxl.Workbook(); ws = wb.active
    ws.append(["Daftar Pasien Rawat Inap"])
    ws.append(["", "Tgl Registrasi", "No Registrasi", "Flag", "No. Rekam Medis", "EMR 2.1",
               "Nama Pasien", "Tgl Lahir", "Umur", "Dokter", "Dokter Tambahan", "Jenis Kelamin",
               "Tipe Pembayaran", "Jenis Peserta", "Kelas", "Kamar", "Bed", "Lama Rawat",
               "Kondisi Klinis", "Verif Farmasi"])
    ws.append(["Ruangan"])
    ws.append(["", "2026-08-28 08:00:00", "1", "", mr, "", nama, "01-01-1990", "36 thn",
               "dr Test", "", "LAKI-LAKI", "BPJS", "PEKERJA MANDIRI", "Kelas III", "315", "1",
               "", "HIJAU", "x"])
    wb.save(path)

def make_operan(path, mr, operan, mr_is_number):
    wb = openpyxl.Workbook(); ws = wb.active
    ws.append(["LAPORAN PASIEN"])
    ws.append(["KAMAR", "BED", "NAMA", "MEDREC", "DPJP", "DIAGNOSA", "OPERAN", "TERAPI"])
    ws.append(["315", "1", "PAT A", (mr if mr_is_number else str(mr)), "dr Test", "diag", operan, "terapi"])
    wb.save(path)

def test_main():
    tmpdir = tempfile.mkdtemp(prefix="rekap-mr-lz-")
    data_file = os.path.join(tmpdir, "master_data.json")
    f_reg = os.path.join(tmpdir, "nusin-28-08-26.xlsx")
    f_op1 = os.path.join(tmpdir, "operan-nusin-28-08-26-v1.xlsx")
    f_op2 = os.path.join(tmpdir, "operan-nusin-28-08-26-v2.xlsx")
    make_registry(f_reg, "067016", "PAT A")
    make_operan(f_op1, "067016", "FIRST", mr_is_number=False)
    make_operan(f_op2, 67016, "SECOND", mr_is_number=True)  # numeric -> leading zero lost

    env = dict(os.environ, DATA_FILE=data_file)
    proc = subprocess.Popen(["node", "server.js", str(PORT)], cwd=HERE, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 15
        while time.time() < deadline:
            if port_open(PORT): break
            if proc.poll() is not None: raise RuntimeError("server exited early")
            time.sleep(0.1)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"http://localhost:{PORT}/index.html", wait_until="domcontentloaded")
            page.wait_for_timeout(600)
            page.locator("#excelInput").set_input_files([f_reg]); page.wait_for_timeout(1500)
            page.locator("#excelInput").set_input_files([f_op1]); page.wait_for_timeout(1500)
            page.locator("#excelInput").set_input_files([f_op2]); page.wait_for_timeout(1500)

            out = page.evaluate("""
              (() => {
                const rs = rows.filter(r => r.mr === '067016' || r.mr === '67016');
                return { totalRows: rows.length,
                  matching: rs.map(r => ({ id: r.id, mr: r.mr, operan: r.operan, archived: r.archived })) };
              })()
            """)
            # Exactly ONE row for this patient (no duplicate).
            assert len(out["matching"]) == 1, f"expected 1 row, got {out['matching']}"
            row = out["matching"][0]
            # It is the canonical zero-padded row, still active.
            assert row["mr"] == "067016", f"wrong canonical MR: {row['mr']}"
            assert row["archived"] is False, "row was wrongly archived"
            # The numeric-MR operan update landed on it (latest wins).
            assert row["operan"] == "SECOND", f"operan not updated: {row['operan']!r}"
            assert errors == [], f"JS errors: {errors}"
            browser.close()
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill()
        shutil.rmtree(tmpdir, ignore_errors=True)

    print("Numeric MR (leading zero dropped) merges into the existing row — no duplicate.")
