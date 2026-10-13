"""Verify #1 (Riwayat = past days only) and #3 (editable clinical fields on all facilities)."""
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
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        # Load days 25-27 (AYSHA 884240 is active on all three; day 28 would
        # auto-archive her, which is correct but not what this test exercises).
        files = day_files("25") + day_files("26") + day_files("27")
        page.locator("#excelInput").set_input_files(files)
        page.wait_for_timeout(2500)

        out = {}
        # ── #1: Riwayat shows PAST days only ──
        # AYSHA (884240) appears on 25,26,27. Current=27 → past = 2 days (25,26)
        aysha = page.locator("tr", has=page.locator("td.mr-col", has_text="884240")).first
        btn = aysha.locator(".btn-history")
        out["aysha_riwayat_btn"] = btn.inner_text().strip() if btn.count() else "(none)"
        btn.click()
        page.wait_for_timeout(300)
        out["aysha_past_dates"] = page.evaluate("Array.from(document.querySelectorAll('.history-table .h-date')).map(e=>e.textContent)")
        out["aysha_past_count"] = page.locator(".history-table tbody tr").count()
        # Invariant: for EVERY rendered row, the Riwayat button count must equal
        # the number of PAST days (history entries != current dateAdded).
        out["riwayat_invariant"] = page.evaluate("""
          (() => {
            let checked = 0, bad = 0, singleDayNoBtn = 0, singleDayTotal = 0;
            document.querySelectorAll('#tableWrap tbody tr').forEach(tr => {
              const m = tr.querySelector('td.mr-col'); if (!m) return;
              const mr = m.textContent.trim();
              const row = rows.find(r => r.mr === mr && !r.archived);
              if (!row) return;
              checked++;
              const past = (row.history||[]).filter(e => e.date !== row.dateAdded).length;
              const btn = tr.querySelector('.btn-history');
              const shown = btn ? parseInt(btn.textContent.match(/\\((\\d+)\\)/)[1], 10) : 0;
              if (shown !== past) bad++;
              if (past === 0) { singleDayTotal++; if (!btn) singleDayNoBtn++; }
            });
            return { checked, mismatches: bad, singleDayRows: singleDayTotal, singleDayWithoutBtn: singleDayNoBtn };
          })()
        """)

        # ── #3: editable clinical fields on ALL facilities ──
        # Sakura tab should now have Diagnosis/Operan/Terapi columns
        page.locator("#tab_sakura").click()
        page.wait_for_timeout(300)
        out["sakura_headers"] = page.evaluate("Array.from(document.querySelectorAll('#tableWrap th')).map(t=>t.textContent)")
        # Count clinical editable cells on Sakura (3 per row: Diagnosis/Operan/Terapi)
        out["sakura_clin_cells_per_row"] = page.evaluate("""
          (() => {
            const tr = document.querySelector('#tableWrap tbody tr');
            return tr ? tr.querySelectorAll('td.edit-cell').length : 0;
          })()
        """)
        # Click the first Sakura row's Diagnosis cell to edit, type, blur to commit
        # (grab the rendered row's MR so we check the SAME row we typed into)
        first_sakura_mr = page.evaluate("""
          (() => {
            const tr = document.querySelector('#tableWrap tbody tr');
            return tr ? tr.querySelector('td.mr-col').textContent.trim() : null;
          })()
        """)
        diag_cell = page.locator("#tableWrap tbody tr").first.locator("td.edit-cell").first
        diag_cell.click()
        page.wait_for_timeout(150)
        diag_ta = page.locator("textarea.edit-input").first
        diag_ta.fill("MANUAL-DIAG-TEST")
        page.locator("body").click(position={"x": 5, "y": 5})  # blur → commit
        page.wait_for_timeout(200)
        out["sakura_typed_mr"] = first_sakura_mr
        out["sakura_diag_stored"] = page.evaluate(f"rows.find(r=>r.mr==='{first_sakura_mr}' && r.facility==='sakura').diagnosis")
        # Cell must render back as plain text (no textarea) with the full value
        out["sakura_diag_rendered"] = page.evaluate("""
          (() => {
            const tr = document.querySelector('#tableWrap tbody tr');
            if (!tr) return null;
            const cell = tr.querySelector('td.edit-cell');
            return { text: cell ? cell.textContent.trim() : null, hasTextarea: !!tr.querySelector('textarea') };
          })()
        """)

        # Melati tab also has clinical columns
        page.locator("#tab_melati").click()
        page.wait_for_timeout(300)
        out["melati_headers"] = page.evaluate("Array.from(document.querySelectorAll('#tableWrap th')).map(t=>t.textContent)")

        out["js_errors"] = errors
        browser.close()

    print(json.dumps(out, indent=2, ensure_ascii=False))
