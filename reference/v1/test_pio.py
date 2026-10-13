"""Verify: PIO (daily task) behaves EXACTLY like Telaah Resep.

The strongest check for "works just like telaah resep" is to drive BOTH items
through the same sequence and assert they stay in lockstep at every step:
  - both are per-row checklist items (render in the row checklist cell)
  - both are DAILY: cleared when a NEW (later) day's file is loaded
  - both are kept when the SAME day's file is reloaded (idempotent)
  - both are kept when an OLDER file is loaded out of order
  - both archive their cleared check into a log field (pioLog / telaahLog)
  - both still appear in the Rekap tab after being cleared
  - a "PIO" filter button exists in the facility filter bar
  - the 5 per-patient checklist items are never touched by a merge

Note: checklist timestamps use nowDT() (real current time), so rekap/log dates
are "today", not the file dates — the test therefore compares PIO vs telaah
side by side rather than asserting specific calendar dates.

Run:  python3 -m pytest test_pio.py -v
"""
import glob
from playwright.sync_api import sync_playwright

from conftest import BASE, DATA  # noqa: E402

MR = "884240"  # Aysha — present in the nusin registry files for days 25/26/27

def day_files(day):
    all_files = sorted(glob.glob(DATA + "/*.xlsx"))
    return [f for f in all_files if f.split("/")[-1].split(".")[0].endswith(day + "-08-26")
            or f.split("/")[-1].split(".")[0].endswith(day + "-8-26")]

def test_main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        # Fresh state: the test server must start with an empty master file.
        assert page.evaluate("rows.length") == 0, "server did not start clean"

        def state():
            return page.evaluate(f"""({{
              pio: rows.find(r=>r.mr==='{MR}').checklist.pio,
              telaah: rows.find(r=>r.mr==='{MR}').checklist.telaah_resep,
              visite: (patientChecklist['{MR}']||{{}}).visite,
              dateAdded: rows.find(r=>r.mr==='{MR}').dateAdded,
              pioLog: rows.find(r=>r.mr==='{MR}').pioLog,
              telaahLog: rows.find(r=>r.mr==='{MR}').telaahLog
            }})""")

        # ── 1. Load day 25, check BOTH PIO and telaah + one patient-level item
        page.locator("#excelInput").set_input_files(day_files("25"))
        page.wait_for_timeout(1500)
        assert page.evaluate(f"rows.find(r=>r.mr==='{MR}')") is not None, "MR not in day-25 file"
        page.evaluate(f"toggleRowCheck('{MR}_nusin','pio')")
        page.evaluate(f"toggleRowCheck('{MR}_nusin','telaah_resep')")
        page.evaluate(f"togglePatientCheck('{MR}','visite')")
        page.wait_for_timeout(200)
        s = state()
        assert s["pio"] is not None, "PIO not set on day 25"
        assert s["telaah"] is not None, "telaah not set on day 25"
        # Both set on the same day (compare the date part — the two toggle calls
        # can land in different wall-clock seconds, which is fine).
        assert s["pio"].split(" ")[0] == s["telaah"].split(" ")[0], \
            f"PIO/telaah set on different days: {s['pio']} vs {s['telaah']}"
        assert s["visite"], "patient-level visite not set"
        assert s["dateAdded"] == "2026-08-25"

        # ── 2. Load day 26 → day advances → BOTH cleared, archived to logs ──
        page.locator("#excelInput").set_input_files(day_files("26"))
        page.wait_for_timeout(2500)
        s = state()
        assert s["dateAdded"] == "2026-08-26", f"date did not advance: {s['dateAdded']}"
        assert s["pio"] is None, f"PIO not cleared on new day: {s['pio']}"
        assert s["telaah"] is None, f"telaah not cleared on new day: {s['telaah']}"
        assert s["pioLog"] and s["telaahLog"], "cleared checks not archived to logs"
        assert len(s["pioLog"]) == len(s["telaahLog"]), \
            f"pioLog/telaahLog entry counts diverged: {len(s['pioLog'])} vs {len(s['telaahLog'])}"
        assert s["visite"], "patient-level item was touched by merge"

        # ── 3. Re-check BOTH, RELOAD same day-26 files → BOTH kept ──────────
        page.evaluate(f"toggleRowCheck('{MR}_nusin','pio')")
        page.evaluate(f"toggleRowCheck('{MR}_nusin','telaah_resep')")
        page.wait_for_timeout(200)
        page.locator("#excelInput").set_input_files(day_files("26"))
        page.wait_for_timeout(2500)
        s = state()
        assert s["pio"] is not None, f"PIO not kept on same-day reload: {s['pio']}"
        assert s["telaah"] is not None, f"telaah not kept on same-day reload: {s['telaah']}"

        # ── 4. Load OLDER file (day 25) out of order → BOTH survive ─────────
        page.locator("#excelInput").set_input_files(day_files("25"))
        page.wait_for_timeout(2500)
        s = state()
        assert s["pio"] is not None, f"PIO cleared by older out-of-order file: {s['pio']}"
        assert s["telaah"] is not None, f"telaah cleared by older out-of-order file: {s['telaah']}"
        assert s["dateAdded"] == "2026-08-26", "older file rolled dateAdded back"

        # ── 5. Load day 27 → day advances → BOTH cleared ────────────────────
        page.locator("#excelInput").set_input_files(day_files("27"))
        page.wait_for_timeout(2500)
        s = state()
        assert s["dateAdded"] == "2026-08-27"
        assert s["pio"] is None, f"PIO not cleared on day 27: {s['pio']}"
        assert s["telaah"] is None, f"telaah not cleared on day 27: {s['telaah']}"

        # ── 6. REKAP: BOTH must still appear (archived work is not lost) ────
        page.evaluate(f"toggleRowCheck('{MR}_nusin','pio')")
        page.evaluate(f"toggleRowCheck('{MR}_nusin','telaah_resep')")
        page.wait_for_timeout(200)
        page.locator("#tab_rekap").click()
        page.wait_for_timeout(300)
        rekap = page.evaluate("""
          (() => {
            const r = buildRekapData();
            const pioDays = {}, telaahDays = {};
            Object.keys(r).sort().forEach(d => {
              if (r[d].pio) pioDays[d] = r[d].pio.mrs;
              if (r[d].telaah_resep) telaahDays[d] = r[d].telaah_resep.mrs;
            });
            return { pioDays, telaahDays };
          })()
        """)
        assert rekap["pioDays"], "PIO missing from rekap entirely"
        assert set(rekap["pioDays"].keys()) == set(rekap["telaahDays"].keys()), \
            f"PIO and telaah appear on different rekap dates: {rekap}"
        for d in rekap["pioDays"]:
            assert MR in rekap["pioDays"][d] and MR in rekap["telaahDays"][d], \
                f"MR {MR} not in rekap for {d}: {rekap}"

        # ── 7. UI: PIO checkbox renders in the checklist cell; filter btn ───
        page.locator("#tab_nusin").click()
        page.wait_for_timeout(300)
        assert page.locator("#filterBtnPIO").count() == 1, "PIO filter button missing"
        cl_labels = page.evaluate(
            "Array.from(document.querySelectorAll('#tableWrap .cl-item label')).map(l => l.textContent.trim())")
        assert "PIO" in cl_labels, f"PIO checkbox not rendered in checklist cell: {cl_labels}"
        assert "Telaah Resep" in cl_labels, "Telaah Resep checkbox missing (control)"

        # ── 8. Invariant: no row carries a pio timestamp older than dateAdded
        stale = page.evaluate("""
          (() => {
            const bad = [];
            rows.forEach(r => {
              const ts = (r.checklist||{}).pio;
              if (ts && ts.slice(0,10) < r.dateAdded) bad.push(r.id + ':' + ts + ' < ' + r.dateAdded);
            });
            return bad;
          })()
        """)
        assert stale == [], f"stale PIO timestamps: {stale}"
        assert errors == [], f"JS errors: {errors}"

        browser.close()

    print("PIO behaves exactly like Telaah Resep — all assertions passed.")
