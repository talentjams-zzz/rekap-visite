"""Verify the ASO (meds-to-stop) column.

- A med whose stopDate is on/before today shows a red "due to stop" warning.
- A med with a future stopDate shows no warning.
- Confirming "stopped" (✓) clears the warning and records stoppedAt.
- The "ASO ⚠" filter button shows only patients with a med due to stop.
- ASO data persists in the row (saved with the master data).
- Archived rows render ASO read-only (no inputs).

Run:  python3 -m pytest test_aso.py -v
"""
import glob, datetime
from playwright.sync_api import sync_playwright

from conftest import BASE, DATA  # noqa: E402

MR = "884240"  # Aysha — present in the nusin registry files for days 25/26/27

def day_files(day):
    all_files = sorted(glob.glob(DATA + "/*.xlsx"))
    return [f for f in all_files if f.split("/")[-1].split(".")[0].endswith(day + "-08-26")
            or f.split("/")[-1].split(".")[0].endswith(day + "-8-26")]

def test_main():
    today = datetime.date.today()
    past = (today - datetime.timedelta(days=2)).isoformat()
    future = (today + datetime.timedelta(days=5)).isoformat()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)
        assert page.evaluate("rows.length") == 0, "server did not start clean"

        # Load day 25 so the patient row exists.
        page.locator("#excelInput").set_input_files(day_files("25"))
        page.wait_for_timeout(1500)
        assert page.evaluate(f"rows.find(r=>r.mr==='{MR}')") is not None, "MR not in day-25 file"

        # ── 0. Empty ASO cell still shows the "+ Add med" button ───────────
        add_btns = page.evaluate(
            "Array.from(document.querySelectorAll('#tableWrap .aso-add')).length")
        assert add_btns > 0, "no '+ Add med' button on empty ASO cells"
        print(f"0. Empty ASO cell shows '+ Add med' button: OK ({add_btns} buttons)")

        # ── 1. Add a med with a PAST stop date → warning shows ─────────────
        page.evaluate(f"asoAdd('{MR}_nusin')")
        page.wait_for_timeout(200)
        page.evaluate(f"asoSetName('{MR}_nusin', 0, 'Ceftriaxone')")
        page.evaluate(f"asoSetDate('{MR}_nusin', 0, '{past}')")
        page.wait_for_timeout(200)
        st = page.evaluate(f"""({{
          due: asoDueCount(rows.find(r=>r.id==='{MR}_nusin')),
          badge: !!document.querySelector('#tableWrap .aso-due-badge'),
          dueItem: !!document.querySelector('#tableWrap .aso-item.due')
        }})""")
        assert st["due"] == 1, f"expected 1 due med, got {st['due']}"
        assert st["badge"], "red 'due to stop' badge not shown"
        assert st["dueItem"], "med item not highlighted red"
        print("1. Past stop date -> red warning: OK")

        # ── 2. Add a med with a FUTURE stop date → no warning ──────────────
        page.evaluate(f"asoAdd('{MR}_nusin')")
        page.wait_for_timeout(200)
        page.evaluate(f"asoSetName('{MR}_nusin', 1, 'Metronidazole')")
        page.evaluate(f"asoSetDate('{MR}_nusin', 1, '{future}')")
        page.wait_for_timeout(200)
        st = page.evaluate(f"""({{
          due: asoDueCount(rows.find(r=>r.id==='{MR}_nusin')),
          badgeText: (document.querySelector('#tableWrap .aso-due-badge')||{{}}).textContent
        }})""")
        assert st["due"] == 1, f"future med wrongly counted as due: {st['due']}"
        assert st["badgeText"] == "⚠ 1 due to stop", f"badge text wrong: {st['badgeText']}"
        print("2. Future stop date -> no warning: OK")

        # ── 3. Confirm stopped on the due med → warning clears ─────────────
        page.evaluate(f"asoToggleStopped('{MR}_nusin', 0)")
        page.wait_for_timeout(200)
        st = page.evaluate(f"""({{
          due: asoDueCount(rows.find(r=>r.id==='{MR}_nusin')),
          badge: !!document.querySelector('#tableWrap .aso-due-badge'),
          stopped: rows.find(r=>r.id==='{MR}_nusin').aso[0].stopped,
          stoppedAt: rows.find(r=>r.id==='{MR}_nusin').aso[0].stoppedAt
        }})""")
        assert st["due"] == 0, f"warning not cleared after confirm: {st['due']}"
        assert not st["badge"], "badge still shown after confirm"
        assert st["stopped"] and st["stoppedAt"], "stopped/stoppedAt not recorded"
        print("3. Confirm stopped -> warning cleared: OK")

        # ── 4. Un-confirm → warning returns ────────────────────────────────
        page.evaluate(f"asoToggleStopped('{MR}_nusin', 0)")
        page.wait_for_timeout(200)
        assert page.evaluate(f"asoDueCount(rows.find(r=>r.id==='{MR}_nusin'))") == 1, "warning did not return"
        print("4. Un-confirm -> warning returns: OK")

        # ── 5. ASO filter: only patients with a due med are shown ──────────
        page.evaluate("toggleFilter('aso')")
        page.wait_for_timeout(300)
        visible = page.evaluate("""
          Array.from(document.querySelectorAll('#tableWrap tbody tr'))
            .filter(tr => !tr.classList.contains('history-row') && !tr.classList.contains('lab-row'))
            .map(tr => tr.cells[2] ? tr.cells[2].textContent.trim() : '')
        """)
        # MR column index: tglReg(0) dateAdded(1) mr(2)
        assert MR in visible, f"patient with due med not shown under ASO filter: {visible}"
        # A patient with no ASO meds must NOT be shown.
        other = page.evaluate("""
          (() => { const r = rows.find(x => !x.archived && x.facility === 'nusin' && x.mr !== '884240');
            return r ? r.mr : null; })()
        """)
        if other:
            assert other not in visible, f"patient without due med wrongly shown: {other}"
        page.evaluate("toggleFilter('aso')")  # clear filter
        page.wait_for_timeout(200)
        print("5. ASO filter shows only patients with due meds: OK")

        # ── 6. Persistence: aso is part of the saved row data ──────────────
        persisted = page.evaluate("""
          (() => { const d = currentData(); const r = d.rows.find(x => x.mr === '884240');
            return r && Array.isArray(r.aso) && r.aso.length === 2; })()
        """)
        assert persisted, "aso not included in saved master data"
        print("6. ASO persists in master data: OK")

        # ── 7. Archived rows render ASO read-only ──────────────────────────
        page.evaluate(f"toggleArchive('{MR}_nusin')")
        page.wait_for_timeout(300)
        page.locator("#tab_archived").click()
        page.wait_for_timeout(300)
        ro = page.evaluate("""
          (() => {
            const cell = document.querySelector('#tableWrap .aso-cell');
            if (!cell) return { found: false };
            return { found: true,
              hasInput: !!cell.querySelector('input'),
              hasAddBtn: !!cell.querySelector('.aso-add') };
          })()
        """)
        assert ro["found"], "ASO cell not rendered on archived row"
        assert not ro["hasInput"] and not ro["hasAddBtn"], f"archived ASO not read-only: {ro}"
        print("7. Archived row ASO is read-only: OK")

        assert errors == [], f"JS errors: {errors}"
        browser.close()

    print("ASO column works as specified — all assertions passed.")
