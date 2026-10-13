"""Regression test: an UPDATED lab file whose only new content is a Resistensi
(antibiotic-resistance) finding must actually change the stored report.

The resistensi finding is stored in a "REPORT" row (result text in the Komentar
column, e.g. "Extended Spectrum Beta Lactamase(ESBL)"). The old parser skipped
every REPORT row, so such a file parsed to the SAME report as the old one and
the "full replace" appeared to do nothing. This test generates its own fixtures
(no PHI) and verifies the fix end-to-end.
"""
import json, os, tempfile
import openpyxl
from playwright.sync_api import sync_playwright

from conftest import BASE  # noqa: E402


def _make_lab(path, with_resistensi):
    """A lab workbook. with_resistensi adds a Resistensi section whose finding
    lives in a REPORT row (Komentar = ESBL), dated later than the other tests."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Hasil"
    ws.append(["Hasil Laboratorium"])
    ws.append(["", "Nama Pemeriksaan", "Hasil Pemeriksaan", "Komentar", "Nilai Normal", "Satuan", "Keterangan", "Tanggal Hasil"])
    ws.append(["Jenis: Hematologi"])
    ws.append(["", "Hemoglobin", "8.6", "", "13.2 - 17.3", "g/dL", "", "2026-09-01 08:00:00"])
    ws.append(["", "Leukosit", "9.1", "", "4.0 - 10.0", "10^3/uL", "", "2026-09-01 08:00:00"])
    if with_resistensi:
        ws.append(["Jenis: Resistensi Sputum"])
        # The finding is in a REPORT row, result text in the Komentar column.
        ws.append(["", "REPORT", "", "Extended Spectrum Beta Lactamase(ESBL)", "", "", "", "2026-09-04 08:29:19"])
    # Trailing pure footer (no data) — must always be skipped.
    ws.append(["", "REPORT", "", "", "", "", "", "2026-09-01 08:00:00"])
    wb.save(path)


def test_main():
    tmp = tempfile.mkdtemp(prefix="rekap-resist-")
    old = os.path.join(tmp, "lab-874240.xlsx")
    new = os.path.join(tmp, "lab-874240-new.xlsx")
    _make_lab(old, with_resistensi=False)
    _make_lab(new, with_resistensi=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        page.evaluate("""
          rows.push({ id: '874240_melati', mr: '874240', facility: 'melati', dateAdded: '2026-09-07',
            tglRegistrasi: '2026-09-01', nama: 'RESIST TEST 874240', umur: '', kamar: '', bed: '',
            dokter: '', diagnosis: '', operan: '', terapi: '', hasilLab: null,
            checklist: { telaah_resep: null, catatan_pengobatan: null },
            pharmacistNote: '', archived: false, archivedAt: null, telaahLog: [], catatanLog: [], history: [] });
          render();
        """)
        page.wait_for_timeout(150)

        out = {}
        # 1. Load the OLD file (no resistensi).
        page.locator("#labInput").set_input_files([old])
        page.wait_for_timeout(1500)
        out["after_old"] = page.evaluate("""
          (() => { const r = labResults['874240'];
            return { tests: r.tests.length, maxDate: r.maxDate,
                     hasESBL: r.tests.some(t => /esbl/i.test(t.komentar || '')) }; })()
        """)

        # 2. Load the NEW file (adds a resistensi finding, dated later).
        page.locator("#labInput").set_input_files([new])
        page.wait_for_timeout(1500)
        out["after_new"] = page.evaluate("""
          (() => { const r = labResults['874240'];
            const res = r.tests.filter(t => t.jenis && /resisten/i.test(t.jenis));
            return { tests: r.tests.length, maxDate: r.maxDate,
                     hasESBL: r.tests.some(t => /esbl/i.test(t.komentar || '')),
                     resistensiRows: res.map(t => ({ jenis: t.jenis, nama: t.nama,
                                                     komentar: t.komentar, tanggal: t.tanggal })) }; })()
        """)
        out["js_errors"] = errors
        browser.close()

    print(json.dumps(out, indent=2, ensure_ascii=False))
    o, n = out["after_old"], out["after_new"]
    changed = (o["maxDate"] != n["maxDate"]) or (o["tests"] != n["tests"])
    print()
    print(f"old: {o['tests']} tests, maxDate {o['maxDate']}, ESBL={o['hasESBL']}")
    print(f"new: {n['tests']} tests, maxDate {n['maxDate']}, ESBL={n['hasESBL']}")
    print(f"resistensi rows: {n['resistensiRows']}")
    ok = changed and n["hasESBL"] and not o["hasESBL"] and not out["js_errors"]
    print()
    print("FIX VERIFIED: newer lab file (resistensi) rewrites the report" if ok
          else "STILL BROKEN")
    assert ok, "resistensi update not verified: " + json.dumps(out, ensure_ascii=False)
