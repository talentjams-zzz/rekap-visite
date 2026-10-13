"""Verify: Jenis shown as Excel-like section header rows (once per section),
not a column. Section header shown only if the section has a visible test.
"""
import json
from playwright.sync_api import sync_playwright

from conftest import BASE  # noqa: E402
LAB = "/home/rezza/projects/rekap-visite-nusin/data/lab"

def test_main():
    """Run the verification script body (module-level code)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = b = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        out = {}
        page.evaluate("""
          ['264040'].forEach(mr => {
            rows.push({ id: mr + '_nusin', mr, facility: 'nusin', dateAdded: '2026-08-27',
              tglRegistrasi: '2026-08-26', nama: 'LAB PATIENT ' + mr, umur: '', kamar: '', bed: '',
              dokter: '', diagnosis: '', operan: '', terapi: '', hasilLab: null,
              checklist: { telaah_resep: null, catatan_pengobatan: null },
              pharmacistNote: '', archived: false, archivedAt: null, telaahLog: [], catatanLog: [], history: [] });
          });
          render();
        """)
        page.wait_for_timeout(200)
        page.locator("#labInput").set_input_files([f"{LAB}/lab-264040.xlsx"])
        page.wait_for_timeout(2000)
        page.evaluate("toggleLab('264040_nusin')")
        page.wait_for_timeout(300)

        def state():
            return page.evaluate("""
              (() => {
                const wrap = document.querySelector('#tableWrap .lab-wrap');
                const headers = Array.from(wrap.querySelectorAll('.lab-table thead th')).map(t => t.textContent.trim());
                const sectionRows = Array.from(wrap.querySelectorAll('.lab-section-row'));
                const testRows = Array.from(wrap.querySelectorAll('.lab-table tbody tr:not(.lab-section-row)'));
                return {
                  headers,
                  sectionCount: sectionRows.length,
                  sectionTexts: sectionRows.map(r => r.textContent.trim()),
                  testRowCount: testRows.length,
                  firstTestCols: testRows.length ? testRows[0].querySelectorAll('td').length : 0
                };
              })()
            """)

        out["no_filter"] = state()

        page.evaluate("toggleLabFilter('abnormal')")
        page.wait_for_timeout(200)
        out["filter_abnormal"] = state()

        page.evaluate("toggleLabFilter('abnormal'); toggleLabFilter('kritis')")
        page.wait_for_timeout(200)
        out["filter_kritis"] = state()

        out["js_errors"] = errors
        browser.close()

    print(json.dumps(out, indent=2, ensure_ascii=False))
