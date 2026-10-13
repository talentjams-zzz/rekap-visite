"""Verify: Telaah Resep (daily task) is cleared when a NEW (later) day's file is
loaded, but kept when the SAME day's file is reloaded (idempotent) or when an
OLDER file is loaded out of order. The 5 per-patient checklist items must
never be touched by a merge."""
import glob, json
from playwright.sync_api import sync_playwright

from conftest import BASE, DATA  # noqa: E402

def day_files(day):
    # Exact filenames per day (substring globs are unsafe: "27-08-26" contains "26")
    all_files = sorted(glob.glob(DATA + "/*.xlsx"))
    return [f for f in all_files if f.split("/")[-1].split(".")[0].endswith(day + "-08-26")
            or f.split("/")[-1].split(".")[0].endswith(day + "-8-26")]

def test_main():
    """Run the verification script body (module-level code)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        out = {"files": {d: [f.split("/")[-1] for f in day_files(d)] for d in ("25", "26", "27")}}

        def aysha():
            return page.evaluate("""({
              telaah: rows.find(r=>r.mr==='884240').checklist.telaah_resep,
              visite: patientChecklist['884240'].visite,
              dateAdded: rows.find(r=>r.mr==='884240').dateAdded
            })""")

        # 1. Load day 25, check AYSHA's Telaah Resep + one patient-level item
        page.locator("#excelInput").set_input_files(day_files("25"))
        page.wait_for_timeout(1500)
        page.evaluate("toggleRowCheck('884240_nusin','telaah_resep')")
        page.evaluate("togglePatientCheck('884240','visite')")
        page.wait_for_timeout(200)
        out["after_day25"] = aysha()

        # 2. Load day 26 (same patient appears again) → day advances → telaah cleared
        page.locator("#excelInput").set_input_files(day_files("26"))
        page.wait_for_timeout(2500)
        out["after_day26"] = aysha()

        # 3. Re-check Telaah Resep, then RELOAD the same day-26 files → must be kept
        page.evaluate("toggleRowCheck('884240_nusin','telaah_resep')")
        page.wait_for_timeout(200)
        out["rechecked_day26"] = page.evaluate("rows.find(r=>r.mr==='884240').checklist.telaah_resep")
        page.locator("#excelInput").set_input_files(day_files("26"))
        page.wait_for_timeout(2500)
        out["after_day26_reload"] = aysha()

        # 4. Load an OLDER file (day 25) out of order → current-day check must survive
        page.locator("#excelInput").set_input_files(day_files("25"))
        page.wait_for_timeout(2500)
        out["after_older_day25"] = aysha()

        # 5. Load day 27 → day advances again → telaah cleared
        page.locator("#excelInput").set_input_files(day_files("27"))
        page.wait_for_timeout(2500)
        out["after_day27"] = aysha()

        # 6. REKAP: the cleared (previous day's) Telaah Resep work must still appear.
        #    Check it again for the current day too, so both days show in the rekap.
        page.evaluate("toggleRowCheck('884240_nusin','telaah_resep')")
        page.wait_for_timeout(200)
        page.locator("#tab_rekap").click()
        page.wait_for_timeout(300)
        out["rekap"] = page.evaluate("""
          (() => {
            const rekap = buildRekapData();
            const days = {};
            Object.keys(rekap).sort().forEach(d => {
              days[d] = rekap[d].telaah_resep ? rekap[d].telaah_resep.mrs : [];
            });
            const ayshaLog = rows.find(r=>r.mr==='884240').telaahLog;
            const ayshaCurrent = rows.find(r=>r.mr==='884240').checklist.telaah_resep;
            const dom = Array.from(document.querySelectorAll('#tableWrap .rekap-date'))
              .map(el => el.textContent.trim());
            const ayshaInDom = !!Array.from(document.querySelectorAll('#tableWrap .rekap-mr-tag'))
              .some(el => el.textContent.trim() === '884240');
            return { days, ayshaLog, ayshaCurrent, domDates: dom, ayshaInDom };
          })()
        """)

        # Invariant: no row may carry a telaah timestamp OLDER than its dateAdded
        out["stale_telaah_rows"] = page.evaluate("""
          (() => {
            const bad = [];
            rows.forEach(r => {
              const ts = (r.checklist||{}).telaah_resep;
              if (ts && ts.slice(0,10) < r.dateAdded) bad.push(r.id + ':' + ts + ' < ' + r.dateAdded);
            });
            return bad;
          })()
        """)
        out["js_errors"] = errors
        browser.close()

    print(json.dumps(out, indent=2, ensure_ascii=False))
