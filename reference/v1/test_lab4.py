"""Verify:
1. Patient table columns are user-resizable (drag handle) + horizontal scroll when wide.
2. Copy-filtered-lab-to-clipboard button (format "Test name Value" per line).
"""
import json
from playwright.sync_api import sync_playwright

from conftest import BASE  # noqa: E402
LAB = "/home/rezza/projects/rekap-visite-nusin/data/lab"

def test_main():
    """Run the verification script body (module-level code)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # Mock clipboard to capture what copyLab writes.
        page.add_init_script("""
          window.__copied = null;
          navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
        """)
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        out = {}

        # ── 1. Column structure: colgroup + cols + resize handles ──
        page.evaluate("""
          ['264040'].forEach(mr => {
            rows.push({ id: mr + '_nusin', mr, facility: 'nusin', dateAdded: '2026-08-27',
              tglRegistrasi: '2026-08-26', nama: 'LAB PATIENT ' + mr, umur: '', kamar: '', bed: '',
              dokter: '', diagnosis: '', operan: '', terapi: '', hasilLab: null,
              checklist: { telaah_resep: null, catatan_pengobatan: null },
              pharmacistNote: '', archived: false, archivedAt: null, telaahLog: [], catatanLog: [], history: [] });
          });
          render();
        """)
        page.wait_for_timeout(200)

        out["structure"] = page.evaluate("""
          (() => {
            const table = document.querySelector('#tableWrap table.main-table');
            if (!table) return { hasMainTable: false };
            const cols = table.querySelectorAll('colgroup col');
            const handles = table.querySelectorAll('th .col-resize');
            return {
              hasMainTable: true,
              colCount: cols.length,
              handleCount: handles.length,
              tableWidth: table.style.width,
              firstColWidth: cols[0] ? cols[0].style.width : null
            };
          })()
        """)

        # ── 1b. Simulate a resize drag on the first column handle ──
        out["resize"] = page.evaluate("""
          (() => {
            const table = document.querySelector('#tableWrap table.main-table');
            const handle = table.querySelector('th .col-resize');
            const th = handle.closest('th');
            const before = getColWidth('tglRegistrasi');
            // dispatch mousedown on the handle
            handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 10 }));
            // drag right by 120px
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 220, clientY: 10 }));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 220, clientY: 10 }));
            const after = getColWidth('tglRegistrasi');
            const stored = JSON.parse(localStorage.getItem('rekap-col-widths') || '{}');
            return { before, after, delta: after - before, persisted: stored.tglRegistrasi, tableWidthNow: table.style.width };
          })()
        """)

        # ── 1c. Horizontal scroll: widen a column a lot, table should exceed container ──
        out["scroll"] = page.evaluate("""
          (() => {
            const wrap = document.querySelector('#tableWrap');
            const table = document.querySelector('#tableWrap table.main-table');
            // force a very wide table
            table.style.width = '3000px';
            const scrollable = wrap.scrollWidth > wrap.clientWidth;
            const hasHScroll = wrap.scrollWidth > wrap.clientWidth;
            return { wrapClientWidth: wrap.clientWidth, wrapScrollWidth: wrap.scrollWidth, scrollable };
          })()
        """)

        # ── 2. Copy button: present, and copies filtered tests in "Name Value" format ──
        page.locator("#labInput").set_input_files([f"{LAB}/lab-264040.xlsx"])
        page.wait_for_timeout(2000)
        page.evaluate("toggleLab('264040_nusin')")
        page.wait_for_timeout(300)

        out["copy_button"] = page.evaluate("""
          (() => {
            const wrap = document.querySelector('#tableWrap .lab-wrap');
            const btn = wrap.querySelector('.lab-title .btn-copy');
            return { present: !!btn, text: btn ? btn.textContent.trim() : null };
          })()
        """)

        # Copy with NO filter -> all 169 tests
        page.evaluate("copyLab('264040_nusin')")
        page.wait_for_timeout(200)
        out["copy_all"] = page.evaluate("""
          (() => {
            const t = window.__copied || '';
            const lines = t.split('\\n');
            return { lineCount: lines.length, firstLine: lines[0], lastLine: lines[lines.length-1], sample: lines.slice(0,3) };
          })()
        """)

        # Copy with ABNORMAL filter -> 48 tests
        page.evaluate("toggleLabFilter('abnormal')")
        page.wait_for_timeout(200)
        page.evaluate("copyLab('264040_nusin')")
        page.wait_for_timeout(200)
        out["copy_abnormal"] = page.evaluate("""
          (() => {
            const t = window.__copied || '';
            const lines = t.split('\\n');
            return { lineCount: lines.length, firstLine: lines[0] };
          })()
        """)

        # Copy with KRITIS filter -> 7 tests
        page.evaluate("toggleLabFilter('abnormal'); toggleLabFilter('kritis')")
        page.wait_for_timeout(200)
        page.evaluate("copyLab('264040_nusin')")
        page.wait_for_timeout(200)
        out["copy_kritis"] = page.evaluate("""
          (() => {
            const t = window.__copied || '';
            const lines = t.split('\\n');
            return { lineCount: lines.length, lines };
          })()
        """)

        out["js_errors"] = errors
        browser.close()

    print(json.dumps(out, indent=2, ensure_ascii=False))
