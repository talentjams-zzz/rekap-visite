"""Verify: auto archive/unarchive based on latest input data (per facility).
- After loading day 25+26, MR 103940 (present on 25 & 26) is ACTIVE.
- After loading day 27 (103940 absent), 103940 is AUTO-ARCHIVED.
- A patient present on all days (031933) stays ACTIVE.
- A patient who reappears on the latest day is returned to ACTIVE.
- Loading an OLDER file out of order does NOT wrongly archive current patients.
- The load toast reports how many were archived / returned.
"""
import glob, json
from playwright.sync_api import sync_playwright

from conftest import BASE, DATA  # noqa: E402

def day_files(day):
    all_files = sorted(glob.glob(DATA + "/*.xlsx"))
    return [f for f in all_files if f.split("/")[-1].split(".")[0].endswith(day + "-08-26")
            or f.split("/")[-1].split(".")[0].endswith(day + "-8-26")]

def state(page, mr):
    return page.evaluate("""(mr) => {
      const r = rows.find(x => x.mr === mr && x.facility === 'nusin');
      return r ? { archived: r.archived, dateAdded: r.dateAdded } : null;
    }""", mr)

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

        # 1. Load day 25 + 26 (chronological). 103940 present on both -> active.
        page.locator("#excelInput").set_input_files(day_files("25") + day_files("26"))
        page.wait_for_timeout(3000)
        out["after_25_26"] = {
            "103940": state(page, "103940"),
            "031933": state(page, "031933"),
            "nusin_active": page.evaluate("rows.filter(r=>r.facility==='nusin'&&!r.archived).length"),
            "nusin_archived": page.evaluate("rows.filter(r=>r.facility==='nusin'&&r.archived).length"),
        }

        # 2. Load day 27. 103940 absent -> auto-archived. 031933 present -> stays active.
        page.locator("#excelInput").set_input_files(day_files("27"))
        page.wait_for_timeout(3000)
        out["after_27"] = {
            "103940": state(page, "103940"),
            "031933": state(page, "031933"),
            "nusin_active": page.evaluate("rows.filter(r=>r.facility==='nusin'&&!r.archived).length"),
            "nusin_archived": page.evaluate("rows.filter(r=>r.facility==='nusin'&&r.archived).length"),
        }

        # 3. Out-of-order: reload day 25 (older). 103940 is on day 25 but the LATEST
        #    nusin date is still 27 -> 103940 must STAY archived (not resurrected),
        #    and current patients must NOT be wrongly archived.
        page.locator("#excelInput").set_input_files(day_files("25"))
        page.wait_for_timeout(3000)
        out["after_older_25"] = {
            "103940": state(page, "103940"),
            "031933": state(page, "031933"),
            "nusin_active": page.evaluate("rows.filter(r=>r.facility==='nusin'&&!r.archived).length"),
            "nusin_archived": page.evaluate("rows.filter(r=>r.facility==='nusin'&&r.archived).length"),
        }

        # 4. Return-to-active: manually archive 031933, then load day 27 again
        #    (031933 is present on 27) -> it must be returned to active.
        page.evaluate("toggleArchive('031933_nusin')")
        page.wait_for_timeout(200)
        out["manually_archived_031933"] = state(page, "031933")
        page.locator("#excelInput").set_input_files(day_files("27"))
        page.wait_for_timeout(3000)
        out["after_27_reload_return"] = {
            "031933": state(page, "031933"),
            "103940": state(page, "103940"),
        }

        # 5. Toast text after a load that archives something.
        page.locator("#excelInput").set_input_files(day_files("27"))
        page.wait_for_timeout(3000)
        out["toast"] = page.evaluate("document.getElementById('toast').textContent")

        out["js_errors"] = errors
        browser.close()

    print(json.dumps(out, indent=2, ensure_ascii=False))
