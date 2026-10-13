"""Verify the top-of-page ASO due-alert banner.

- Hidden when no med is due to stop (empty or all-future lists).
- Shown as "⚠️ ASO Alert : N meds" when N >= 1 active patient has a due med
  (total count of meds, across ALL facilities, active rows only).
- Singular "med" for exactly one.
- Live: the count drops by one as each due med is confirmed stopped /
  removed, and the banner disappears at zero — without any reload.
- Archived rows' due meds do NOT count toward the banner.

Run:  python3 -m pytest test_aso_alert.py -v
"""
import glob, datetime
from playwright.sync_api import sync_playwright

from conftest import BASE, DATA  # noqa: E402

MR = "884240"  # Aysha — present in the nusin registry files for days 25/26/27


def day_files(day):
    all_files = sorted(glob.glob(DATA + "/*.xlsx"))
    return [f for f in all_files if f.split("/")[-1].split(".")[0].endswith(day + "-08-26")
            or f.split("/")[-1].split(".")[0].endswith(day + "-8-26")]


def banner_state(page):
    """Return {shown, text} for the ASO alert banner."""
    return page.evaluate("""({
      shown: document.getElementById('asoAlertBanner').style.display !== 'none',
      text:  document.getElementById('asoAlertBanner').textContent
    })""")


def test_main():
    today = datetime.date.today()
    past1 = (today - datetime.timedelta(days=3)).isoformat()
    past2 = (today - datetime.timedelta(days=1)).isoformat()
    future = (today + datetime.timedelta(days=5)).isoformat()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)
        assert page.evaluate("rows.length") == 0, "server did not start clean"

        # ── 1. No data yet → banner hidden ────────────────────────────────
        st = banner_state(page)
        assert not st["shown"], f"banner visible with no data: {st}"
        print("1. Banner hidden with no data: OK")

        # Load day 25 so the patient row exists.
        page.locator("#excelInput").set_input_files(day_files("25"))
        page.wait_for_timeout(1500)
        assert page.evaluate(f"rows.find(r=>r.mr==='{MR}')") is not None, "MR not in day-25 file"

        # ── 2. All-future ASO med → banner stays hidden ───────────────────
        page.evaluate(f"asoAdd('{MR}_nusin')")
        page.evaluate(f"asoSetName('{MR}_nusin', 0, 'Metronidazole')")
        page.evaluate(f"asoSetDate('{MR}_nusin', 0, '{future}')")
        page.wait_for_timeout(200)
        st = banner_state(page)
        assert not st["shown"], f"banner shown for a future-dated med: {st}"
        print("2. Future stop date -> banner stays hidden: OK")

        # ── 3. Add one due med → "ASO Alert : 1 med" (singular) ───────────
        page.evaluate(f"asoAdd('{MR}_nusin')")
        page.evaluate(f"asoSetName('{MR}_nusin', 1, 'Ceftriaxone')")
        page.evaluate(f"asoSetDate('{MR}_nusin', 1, '{past1}')")
        page.wait_for_timeout(200)
        st = banner_state(page)
        assert st["shown"], "banner not shown with 1 due med"
        assert st["text"] == "⚠️ ASO Alert : 1 med", f"singular text wrong: {st['text']}"
        print("3. One due med -> 'ASO Alert : 1 med' (singular): OK")

        # ── 4. Add a second due med → count is total meds (2), plural ─────
        page.evaluate(f"asoAdd('{MR}_nusin')")
        page.evaluate(f"asoSetName('{MR}_nusin', 2, 'Gentamicin')")
        page.evaluate(f"asoSetDate('{MR}_nusin', 2, '{past2}')")
        page.wait_for_timeout(200)
        st = banner_state(page)
        assert st["shown"], "banner not shown with 2 due meds"
        assert st["text"] == "⚠️ ASO Alert : 2 meds", f"plural count wrong: {st['text']}"
        print("4. Two due meds -> 'ASO Alert : 2 meds' (count = total meds): OK")

        # ── 5. Confirm one stopped → drops to 1 without reload ────────────
        page.evaluate(f"asoToggleStopped('{MR}_nusin', 1)")  # stop Ceftriaxone (due)
        page.wait_for_timeout(200)
        st = banner_state(page)
        assert st["text"] == "⚠️ ASO Alert : 1 med", f"count not live-updated: {st['text']}"
        print("5. Confirm stopped -> count drops live to 1: OK")

        # ── 6. Remove the last due med → banner disappears ────────────────
        page.evaluate(f"asoRemove('{MR}_nusin', 2)")  # remove Gentamicin (due)
        page.wait_for_timeout(200)
        st = banner_state(page)
        assert not st["shown"], f"banner still shown at zero due meds: {st}"
        print("6. Last due med removed -> banner hidden: OK")

        # ── 7. Archived rows' due meds do NOT count ───────────────────────
        page.evaluate(f"asoAdd('{MR}_nusin')")
        page.evaluate(f"asoSetName('{MR}_nusin', 0, 'Vancomycin')")
        page.evaluate(f"asoSetDate('{MR}_nusin', 0, '{past1}')")
        page.wait_for_timeout(200)
        assert banner_state(page)["shown"], "sanity: active due med should show banner"
        # Archive the row — its due med must stop counting.
        page.evaluate(f"toggleArchive('{MR}_nusin')")
        page.wait_for_timeout(300)
        st = banner_state(page)
        assert not st["shown"], f"archived row's due med wrongly counted: {st}"
        print("7. Archived row due meds excluded from banner: OK")

        # Restore so the throwaway data file is left tidy (not required).
        page.evaluate(f"toggleArchive('{MR}_nusin')")
        page.wait_for_timeout(200)

        assert errors == [], f"JS errors: {errors}"
        browser.close()

    print("ASO top alert banner works as specified — all assertions passed.")
