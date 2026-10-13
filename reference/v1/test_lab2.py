"""Verify the 3 Hasil Lab adjustments:
1. eGFR normal value always overridden to ">60" (abnormal when < 60)
2. Abnormal + Kritis filters on the lab table (union)
3. Jenis shown as Excel-like section header rows (once per section, no column)
"""
import json
from playwright.sync_api import sync_playwright

from conftest import BASE  # noqa: E402
LAB = "/home/rezza/projects/rekap-visite-nusin/data/lab"

def test_main():
    """Run the verification script body (module-level code)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        out = {}

        # ── 1. eGFR override: parse 180302 and 604340, check eGFR rows ──
        out["egfr"] = page.evaluate("""
          (async () => {
            const res = {};
            for (const f of ['lab-180302.xlsx','lab-604340.xlsx']) {
              const buf = await (await fetch('/data/lab/' + f)).arrayBuffer();
              const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
              const rep = parseLabFile(wb);
              const egfr = rep.tests.find(t => /egfr/i.test(t.nama));
              res[f] = egfr ? { nama: egfr.nama, hasil: egfr.hasil, normal: egfr.normal, abnormal: egfr.abnormal } : null;
            }
            return res;
          })()
        """)

        # ── Parse counts (with eGFR override) vs expected ──
        out["parse"] = page.evaluate("""
          (async () => {
            const files = ['lab-180302.xlsx','lab-264040.xlsx','lab-604340.xlsx','lab-897239.xlsx'];
            const res = {};
            for (const f of files) {
              const buf = await (await fetch('/data/lab/' + f)).arrayBuffer();
              const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
              const rep = parseLabFile(wb);
              res[f] = {
                tests: rep.tests.length,
                abnormal: rep.tests.filter(t => t.abnormal).length,
                kritis: rep.tests.filter(t => t.kritis).length
              };
            }
            return res;
          })()
        """)

        # ── 2 & 3: load 264040 (has kritis), create row, expand, check Jenis + filters ──
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

        # 3. Jenis as Excel-like section header rows (once per section, no column)
        out["jenis"] = page.evaluate("""
          (() => {
            const wrap = document.querySelector('#tableWrap .lab-wrap');
            const headers = Array.from(wrap.querySelectorAll('.lab-table thead th')).map(t => t.textContent.trim());
            const sectionRows = Array.from(wrap.querySelectorAll('.lab-section-row'));
            const testRows = Array.from(wrap.querySelectorAll('.lab-table tbody tr:not(.lab-section-row)'));
            return {
              headers,
              sectionCount: sectionRows.length,
              testRowCount: testRows.length,
              firstTestCols: testRows.length ? testRows[0].querySelectorAll('td').length : 0
            };
          })()
        """)

        # 2. Filters: baseline counts, then abnormal-only, kritis-only, both
        def counts():
            return page.evaluate("""
              (() => {
                const wrap = document.querySelector('#tableWrap .lab-wrap');
                const rows = Array.from(wrap.querySelectorAll('.lab-table tbody tr:not(.lab-section-row)'));
                return {
                  shown: rows.length,
                  abnormal: rows.filter(r => r.classList.contains('lab-row-abnormal')).length,
                  kritis: rows.filter(r => r.classList.contains('lab-row-kritis')).length
                };
              })()
            """)

        out["filter_baseline"] = counts()
        page.evaluate("toggleLabFilter('abnormal')")
        page.wait_for_timeout(200)
        out["filter_abnormal"] = counts()
        page.evaluate("toggleLabFilter('abnormal')")  # off
        page.evaluate("toggleLabFilter('kritis')")
        page.wait_for_timeout(200)
        out["filter_kritis"] = counts()
        page.evaluate("toggleLabFilter('abnormal')")  # both on (union)
        page.wait_for_timeout(200)
        out["filter_both"] = counts()
        # reset
        page.evaluate("toggleLabFilter('abnormal'); toggleLabFilter('kritis')")
        page.wait_for_timeout(200)
        out["filter_reset"] = counts()

        # Filter buttons present with counts
        out["filter_buttons"] = page.evaluate("""
          (() => {
            const wrap = document.querySelector('#tableWrap .lab-wrap');
            return Array.from(wrap.querySelectorAll('.lab-filter-bar .filter-btn')).map(b => b.textContent.trim());
          })()
        """)

        out["js_errors"] = errors
        browser.close()

    print(json.dumps(out, indent=2, ensure_ascii=False))
