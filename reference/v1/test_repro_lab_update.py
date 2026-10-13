"""Regression test for the 3 lab fixes:
1. BUG FIX: an 'updated' lab file with a cover/summary sheet BEFORE the data
   sheet now parses. Previously parseLabFile only read sheet[0], so such a file
   returned null -> handleLabLoad skipped it -> the OLD lab result stayed.
2. New Komentar column is parsed from the Excel and shown in the lab table.
3. Every lab-table column is freely resizable (colgroup + resize handles) and
   widths persist in labColWidths (localStorage + master JSON).

Fixtures are generated at runtime (openpyxl) so the test is self-contained.
"""
import json, base64, os, tempfile
import openpyxl
from playwright.sync_api import sync_playwright

from conftest import BASE, HERE  # noqa: E402


def _make_cover_sheet(path):
    """A lab workbook with a Cover sheet BEFORE the Hasil sheet (the bug trigger)."""
    wb = openpyxl.Workbook()
    cover = wb.active
    cover.title = "Cover"
    cover["A1"] = "LAB REPORT - UPDATED"
    cover["A2"] = "Patient: 264040"
    ws = wb.create_sheet("Hasil")
    ws.append(["Hasil Laboratorium"])
    ws.append(["", "Nama Pemeriksaan", "Hasil Pemeriksaan", "Komentar", "Nilai Normal", "Satuan", "Keterangan", "Tanggal Hasil"])
    ws.append(["Jenis: Hematologi"])
    ws.append(["", "Hemoglobin", "8.6", "", "13.2 - 17.3", "g/dL", "", "2026-09-05 08:00:00"])
    ws.append(["", "Leukosit", "9.1", "", "4.0 - 10.0", "10^3/uL", "", "2026-09-05 08:00:00"])
    wb.save(path)


def _make_komentar(path):
    """A lab workbook with a filled Komentar column."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Hasil"
    ws.append(["Hasil Laboratorium"])
    ws.append(["", "Nama Pemeriksaan", "Hasil Pemeriksaan", "Komentar", "Nilai Normal", "Satuan", "Keterangan", "Tanggal Hasil"])
    ws.append(["Jenis: Hematologi"])
    ws.append(["", "Hemoglobin", "8.6", "rendah, perlu transfusi", "13.2 - 17.3", "g/dL", "", "2026-09-05 08:00:00"])
    ws.append(["", "Leukosit", "9.1", "", "4.0 - 10.0", "10^3/uL", "", "2026-09-05 08:00:00"])
    wb.save(path)


def _b64(path):
    return base64.b64encode(open(path, "rb").read()).decode()


def test_main():
    tmp = tempfile.mkdtemp(prefix="rekap-lab-")
    cover = os.path.join(tmp, "v-cover.xlsx")
    kom = os.path.join(tmp, "v-komentar.xlsx")
    _make_cover_sheet(cover)
    _make_komentar(kom)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        out = {}

        # ── 1. BUG FIX: cover-sheet file now parses (was null before) ──
        out["cover_sheet"] = page.evaluate("""
          (b64) => {
            const bin = atob(b64); const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const rep = parseLabFile(XLSX.read(bytes, { type: 'array' }));
            return rep ? { parsed: true, tests: rep.tests.length,
                           first: rep.tests[0].nama + '=' + rep.tests[0].hasil }
                       : { parsed: false };
          }
        """, _b64(cover))

        # ── 2. Komentar column parsed ──
        out["komentar"] = page.evaluate("""
          (b64) => {
            const bin = atob(b64); const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const rep = parseLabFile(XLSX.read(bytes, { type: 'array' }));
            if (!rep) return { parsed: false };
            const t = rep.tests.find(x => x.nama === 'Hemoglobin');
            return { parsed: true, hasKomentarField: 'komentar' in t,
                     hemoglobinKomentar: t ? t.komentar : null };
          }
        """, _b64(kom))

        # ── 3. Lab table resizable: colgroup + handles + persistence ──
        page.evaluate("""
          rows.push({ id: '264040_nusin', mr: '264040', facility: 'nusin', dateAdded: '2026-08-27',
            tglRegistrasi: '2026-08-26', nama: 'LAB PATIENT 264040', umur: '', kamar: '', bed: '',
            dokter: '', diagnosis: '', operan: '', terapi: '', hasilLab: null,
            checklist: { telaah_resep: null, catatan_pengobatan: null },
            pharmacistNote: '', archived: false, archivedAt: null, telaahLog: [], catatanLog: [], history: [] });
          render();
        """)
        page.wait_for_timeout(150)
        page.locator("#labInput").set_input_files([os.path.join(HERE, "data/lab/lab-264040.xlsx")])
        page.wait_for_timeout(1500)
        page.evaluate("toggleLab('264040_nusin')")
        page.wait_for_timeout(300)
        out["lab_table"] = page.evaluate("""
          (() => {
            const table = document.querySelector('#tableWrap .lab-table');
            if (!table) return null;
            const cols = table.querySelectorAll('colgroup col');
            const handles = table.querySelectorAll('th .col-resize');
            const headers = Array.from(table.querySelectorAll('thead th')).map(t => t.textContent.trim());
            return { hasColgroup: cols.length, resizeHandles: handles.length, headers,
                     hasKomentarHeader: headers.includes('Komentar'), tableWidth: table.style.width };
          })()
        """)
        # Simulate a real drag on the first lab column's resize handle (+100px).
        out["lab_resize_persist"] = page.evaluate("""
          (() => {
            const handle = document.querySelector('#tableWrap .lab-table thead th .col-resize');
            if (!handle) return { error: 'no handle' };
            const before = getLabColWidth('nama');
            handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200 }));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200 }));
            return { before, after: labColWidths.nama,
                     localStorage: JSON.parse(localStorage.getItem('rekap-lab-col-widths')||'{}').nama };
          })()
        """)

        out["js_errors"] = errors
        browser.close()

    print(json.dumps(out, indent=2, ensure_ascii=False))
    ok = (out["cover_sheet"]["parsed"]
          and out["komentar"]["parsed"] and out["komentar"]["hasKomentarField"]
          and out["lab_table"]["hasColgroup"] == 7
          and out["lab_table"]["resizeHandles"] == 7
          and out["lab_table"]["hasKomentarHeader"]
          and out["lab_resize_persist"]["after"] == out["lab_resize_persist"]["before"] + 100
          and out["lab_resize_persist"]["localStorage"] == out["lab_resize_persist"]["after"]
          and not out["js_errors"])
    print("ALL 3 LAB FIXES VERIFIED" if ok else "LAB FIXES INCOMPLETE")
    assert ok, "lab fixes incomplete: " + json.dumps(out, ensure_ascii=False)
