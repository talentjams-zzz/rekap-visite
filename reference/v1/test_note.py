"""Verify issue #2: pharmacist note persists across a merge (latest-file-wins)."""
import glob, json
from playwright.sync_api import sync_playwright

from conftest import BASE, DATA  # noqa: E402

def day_files(day):
    # Exact day match (substring globs are unsafe: "28-08-26" contains "26").
    all_files = sorted(glob.glob(DATA + "/*.xlsx"))
    return [f for f in all_files if f.split("/")[-1].split(".")[0].endswith(day + "-08-26")
            or f.split("/")[-1].split(".")[0].endswith(day + "-8-26")]

def test_main():
    """Run the verification script body (module-level code)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        # Load only day 25 files (nusin registry + operan)
        day25 = day_files("25")
        page.locator("#excelInput").set_input_files(day25)
        page.wait_for_timeout(1500)

        # Find AYSHA (884240), add a pharmacist note (click cell → edit → blur)
        aysha = page.locator("tr", has=page.locator("td.mr-col", has_text="884240")).first
        note_cell = aysha.locator("td.edit-cell").last
        note_cell.click()
        page.wait_for_timeout(150)
        note_ta = page.locator("textarea.edit-input").first
        note_ta.fill("NOTE-TEST-123")
        page.locator("body").click(position={"x": 5, "y": 5})  # blur → commit
        page.wait_for_timeout(200)
        print("Note after set:", page.evaluate("rows.find(r=>r.mr==='884240').pharmacistNote"))

        # Now load day 26 + 27 files (same patient appears again) -> merge
        later = day_files("26") + day_files("27")
        page.locator("#excelInput").set_input_files(later)
        page.wait_for_timeout(2500)

        # Check note survived the merge
        note_after = page.evaluate("rows.find(r=>r.mr==='884240').pharmacistNote")
        print("Note after merge (day26+27):", note_after)
        print("Note preserved:", note_after == "NOTE-TEST-123")

        # Also check the rendered cell shows it as plain text (no textarea)
        aysha2 = page.locator("tr", has=page.locator("td.mr-col", has_text="884240")).first
        print("Rendered note:", aysha2.locator("td.edit-cell").last.inner_text().strip())

        browser.close()
