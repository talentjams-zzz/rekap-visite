"""Verify: Catatan Pengobatan is a ONE-TIME per-patient task (NOT daily).
- appears in the checklist directly below Telaah Resep
- toggles on/off
- is KEPT when a NEW (later) day's file is loaded (not emptied)
- is KEPT when the SAME day's file is reloaded (idempotent)
- is KEPT when an OLDER file is loaded out of order
- appears in the Rekap tab under the date it was checked
- has a working 'filter undone' button
- Telaah Resep (the daily task) is still cleared on a new day, so the daily
  reset path is unaffected.
"""
import glob, json
from playwright.sync_api import sync_playwright

from conftest import BASE, DATA  # noqa: E402

def day_files(day):
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
              catatan: rows.find(r=>r.mr==='884240').checklist.catatan_pengobatan,
              telaah: rows.find(r=>r.mr==='884240').checklist.telaah_resep,
              dateAdded: rows.find(r=>r.mr==='884240').dateAdded
            })""")

        # 0. The checkbox must exist in the DOM, positioned right after Telaah Resep.
        out["checklist_order"] = page.evaluate("""
          (() => {
            const cell = document.querySelector('#tableWrap .checklist-cell');
            if (!cell) return null;
            return Array.from(cell.querySelectorAll('.cl-item label'))
              .map(l => l.textContent.trim());
          })()
        """)

        # 1. Load day 25, check AYSHA's Catatan Pengobatan AND Telaah Resep.
        page.locator("#excelInput").set_input_files(day_files("25"))
        page.wait_for_timeout(1500)
        page.evaluate("toggleRowCheck('884240_nusin','catatan_pengobatan')")
        page.evaluate("toggleRowCheck('884240_nusin','telaah_resep')")
        page.wait_for_timeout(200)
        out["after_day25"] = aysha()
        out["catatan_ts"] = out["after_day25"]["catatan"]

        # 2. Load day 26 (same patient appears again) -> day advances.
        #    Catatan Pengobatan is ONE-TIME -> KEPT. Telaah Resep is DAILY -> cleared.
        page.locator("#excelInput").set_input_files(day_files("26"))
        page.wait_for_timeout(2500)
        out["after_day26"] = aysha()

        # 3. RELOAD the same day-26 files -> both must be kept (idempotent).
        page.locator("#excelInput").set_input_files(day_files("26"))
        page.wait_for_timeout(2500)
        out["after_day26_reload"] = aysha()

        # 4. Load an OLDER file (day 25) out of order -> current-day work must survive.
        page.locator("#excelInput").set_input_files(day_files("25"))
        page.wait_for_timeout(2500)
        out["after_older_day25"] = aysha()

        # 5. Load day 27 -> day advances again -> Catatan STILL kept (one-time).
        page.locator("#excelInput").set_input_files(day_files("27"))
        page.wait_for_timeout(2500)
        out["after_day27"] = aysha()

        # 6. REKAP: the one-time Catatan Pengobatan must appear under the date it
        #    was checked (the check timestamp's date), and AYSHA must be listed.
        page.locator("#tab_rekap").click()
        page.wait_for_timeout(300)
        out["rekap"] = page.evaluate("""
          (() => {
            const rekap = buildRekapData();
            const days = {};
            Object.keys(rekap).sort().forEach(d => {
              days[d] = rekap[d].catatan_pengobatan ? rekap[d].catatan_pengobatan.mrs : [];
            });
            const ayshaCurrent = rows.find(r=>r.mr==='884240').checklist.catatan_pengobatan;
            const statLabels = Array.from(document.querySelectorAll('#tableWrap .rekap-stat .label'))
              .map(el => el.textContent.trim());
            return { days, ayshaCurrent, statLabels };
          })()
        """)

        # 7. Filter button: 'filter undone' for Catatan Pengobatan must hide done rows.
        page.locator("#tab_nusin").click()
        page.wait_for_timeout(200)
        out["filter"] = page.evaluate("""
          (() => {
            const btn = document.getElementById('filterBtnCP');
            if (!btn) return { exists: false };
            const label = btn.textContent.trim();
            // AYSHA's catatan is done -> filtering undone hides her.
            toggleFilter('catatan_pengobatan');
            const ayshaVisible = !!Array.from(document.querySelectorAll('#tableWrap .mr-col'))
              .some(el => el.textContent.trim() === '884240');
            const count = btn.querySelector('.count') ? btn.querySelector('.count').textContent : null;
            toggleFilter('catatan_pengobatan'); // reset
            return { exists: true, label, count, ayshaHiddenWhenDone: !ayshaVisible };
          })()
        """)

        # Invariant: the DAILY task (Telaah Resep) must never carry a timestamp
        # OLDER than its dateAdded (it is cleared when the day advances). Catatan
        # Pengobatan is one-time, so it is exempt from this invariant.
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

