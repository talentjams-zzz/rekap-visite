"""Headless verification of all fixes in index.html."""
import glob, json
from playwright.sync_api import sync_playwright

from conftest import BASE, DATA  # noqa: E402

def day_files(day):
    # Exact day match (substring globs are unsafe: "28-08-26" contains "26").
    all_files = sorted(glob.glob(DATA + "/*.xlsx"))
    return [f for f in all_files if f.split("/")[-1].split(".")[0].endswith(day + "-08-26")
            or f.split("/")[-1].split(".")[0].endswith(day + "-8-26")]

results = {}
def test_main():
    """Run the verification script body (module-level code)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        # 1. Local SheetJS (no CDN)
        results["xlsx_local"] = page.evaluate("typeof XLSX !== 'undefined' ? XLSX.version : 'MISSING'")
        results["cdn_ref"] = page.evaluate("!!document.querySelector('script[src*=\"cdn.sheetjs\"]')")

        # 2. dateFromFilename unit checks
        results["datefn"] = page.evaluate("""[
          dateFromFilename('nusin 25-8-26.xlsx'),
          dateFromFilename('nusin-26-08-26.xlsx'),
          dateFromFilename('operan nusin 25-8-26.xlsx'),
          dateFromFilename('melati-27-08-26.xlsx'),
          dateFromFilename('no-date-file.xlsx')
        ]""")

        # 3. Feed the days 25-27 files through the real file input (AYSHA 884240 is
        #    active on all three; day 28 would auto-archive her, which is correct but
        #    not what this test exercises).
        files = day_files("25") + day_files("26") + day_files("27")
        page.locator("#excelInput").set_input_files(files)
        page.wait_for_timeout(2500)

        # 4. Riwayat buttons now visible?
        results["rows_nusin"] = page.locator("#tableWrap tbody tr:not(.history-row)").count()
        results["history_buttons"] = page.locator(".btn-history").count()

        # 5. AYSHA (884240) — in all 3 days. Check her row shows latest (27-08) data
        aysha_row = page.locator("tr", has=page.locator("td.mr-col", has_text="884240")).first
        results["aysha_tgl_input"] = aysha_row.locator("td:nth-child(2)").inner_text().strip()
        results["aysha_history_btn"] = aysha_row.locator(".btn-history").inner_text().strip()

        # 6. Expand AYSHA's history and count days
        aysha_row.locator(".btn-history").click()
        page.wait_for_timeout(300)
        hist_rows = page.locator(".history-table tbody tr").count()
        hist_dates = page.evaluate("""Array.from(document.querySelectorAll('.history-table .h-date')).map(e => e.textContent)""")
        results["aysha_history_days"] = hist_rows
        results["aysha_history_dates"] = hist_dates

        # 7. Latest-wins check: AYSHA's DPJP on 27-08 includes "dr Retno" (added that day)
        results["aysha_dokter"] = aysha_row.locator("td:nth-child(8)").inner_text().strip()

        # 8. Handover merge: AYSHA should have diagnosis + operan + terapi filled
        results["aysha_diagnosis"] = aysha_row.locator("td:nth-child(9)").inner_text().strip()[:60]
        results["aysha_therapi"] = aysha_row.locator("td:nth-child(11)").inner_text().strip()[:60]

        # 9. Facility tabs counts
        results["tab_counts"] = page.evaluate("""Array.from(document.querySelectorAll('.tab')).map(t => t.textContent)""")

        # 10. Sakura tab (short columns, no diagnosis/operan/terapi)
        page.locator("#tab_sakura").click()
        page.wait_for_timeout(300)
        results["sakura_rows"] = page.locator("#tableWrap tbody tr:not(.history-row)").count()
        results["sakura_headers"] = page.evaluate("Array.from(document.querySelectorAll('#tableWrap th')).map(t=>t.textContent)")

        # 11. No JS errors
        results["js_errors"] = errors

        browser.close()

    print(json.dumps(results, indent=2, ensure_ascii=False))
