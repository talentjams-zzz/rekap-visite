"""Regression test: manually-typed Diagnosis/Operan/Terapi must appear in Riwayat.

Bug: commitEditCell only updated the MAIN row, never the day's history snapshot.
So a clinical value typed by hand on day X was DROPPED - once day X became a
past day, Riwayat showed its Diagnosis/Operan/Terapi as empty (most visible on
facilities like Sakura that have no handover file and rely on manual entry).

Flow: load days 26+27 -> hand-type the fields on day 27 -> load day 28 (so day
27 becomes a past day) -> assert Riwayat shows the typed values for day 27.
"""
import json
from playwright.sync_api import sync_playwright

from conftest import BASE, DATA  # noqa: E402

TARGET = "656218"  # present in both nusin-27 and nusin-28 registry files
FILES_26_27 = [
    DATA + "/nusin-26-08-26.xlsx",
    DATA + "/operan-nusin-26-08-26.xlsx",
    DATA + "/nusin 27-08-26.xlsx",
    DATA + "/operan-nusin-27-08-26.xlsx",
]
FILES_28 = [
    DATA + "/nusin-28-08-26.xlsx",
    DATA + "/operan-nusin-28-08-26.xlsx",
]

results = {}

def test_main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        # 1. Load days 26 + 27 (current day becomes 27)
        page.locator("#excelInput").set_input_files(FILES_26_27)
        page.wait_for_timeout(2500)

        row = page.locator("tr", has=page.locator("td.mr-col", has_text=TARGET)).first
        results["row_found"] = row.count() > 0
        results["date_added_before"] = row.locator("td .date-badge").first.inner_text().strip()

        # 2. Hand-type Diagnosis / Operan / Terapi on day 27
        for cls, val in [("diag-col", "TEST DIAG 27"), ("operan-col", "TEST OPERAN 27"), ("terapi-col", "TEST TERAPI 27")]:
            row.locator("td." + cls).click()
            page.wait_for_timeout(150)
            ta = row.locator("textarea.edit-input")
            ta.fill(val)
            ta.dispatch_event("blur")
            page.wait_for_timeout(250)

        results["main_diag_after"] = row.locator("td.diag-col").inner_text().strip()

        # 3. Load day 28 (advances current day to 28; day 27 becomes a past day)
        page.locator("#excelInput").set_input_files(FILES_28)
        page.wait_for_timeout(2500)

        row = page.locator("tr", has=page.locator("td.mr-col", has_text=TARGET)).first
        results["date_added_after"] = row.locator("td .date-badge").first.inner_text().strip()

        # 4. Expand Riwayat and read the day-27 row
        btn = row.locator(".btn-history")
        results["riwayat_button"] = btn.inner_text().strip() if btn.count() else "(none)"
        btn.click()
        page.wait_for_timeout(400)

        hist_rows = page.locator(".history-table tbody tr")
        day27 = None
        for i in range(hist_rows.count()):
            cells = hist_rows.nth(i).locator("td")
            vals = [cells.nth(j).inner_text().strip() for j in range(cells.count())]
            if vals and vals[0] == "2026-08-27":
                day27 = vals
        # columns: date, tglReg, nama, umur, kamar, bed, dokter, diagnosis, operan, terapi
        results["day27_diagnosis"] = day27[7] if day27 else None
        results["day27_operan"] = day27[8] if day27 else None
        results["day27_terapi"] = day27[9] if day27 else None
        results["js_errors"] = errors
        browser.close()

    # Assertions: the hand-typed values must survive into Riwayat for day 27.
    assert results["row_found"], "target row not found"
    assert results["date_added_after"] == "2026-08-28", "day did not advance to 28"
    assert results["day27_diagnosis"] == "TEST DIAG 27", "diagnosis lost: %r" % results["day27_diagnosis"]
    assert results["day27_operan"] == "TEST OPERAN 27", "operan lost: %r" % results["day27_operan"]
    assert results["day27_terapi"] == "TEST TERAPI 27", "terapi lost: %r" % results["day27_terapi"]
    assert not results["js_errors"], "JS errors: %r" % results["js_errors"]
    print(json.dumps(results, indent=2, ensure_ascii=False))
