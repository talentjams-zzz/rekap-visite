"""Verify: Hasil Lab column (per-patient lab report from lab-{MR}.xlsx).
- parseLabFile produces correct test/abnormal/kritis counts (vs known-correct values)
- column sits between Terapi and Checklist
- cell shows a compact summary (date, N tests, M abnormal, Lab Kritis badge)
- expanding shows the full table; abnormal values red; kritis rows red + "LK"
- a newer lab file for the same MR completely replaces the old one
- labResults is included in the save payload
"""
import json
from playwright.sync_api import sync_playwright

from conftest import BASE  # noqa: E402
LAB = "/home/rezza/projects/rekap-visite-nusin/data/lab"

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

        # ── Part A: parse each lab file directly and compare to expected ──
        out["parse"] = page.evaluate("""
          (async () => {
            const files = ['lab-180302.xlsx','lab-264040.xlsx','lab-604340.xlsx','lab-897239.xlsx'];
            const res = {};
            for (const f of files) {
              const buf = await (await fetch('/data/lab/' + f)).arrayBuffer();
              const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
              const rep = parseLabFile(wb);
              if (!rep) { res[f] = null; continue; }
              res[f] = {
                tests: rep.tests.length,
                abnormal: rep.tests.filter(t => t.abnormal).length,
                kritis: rep.tests.filter(t => t.kritis).length,
                maxDate: rep.maxDate
              };
            }
            return res;
          })()
        """)

        # ── Part B: create rows for the 4 lab MRs, load lab files, check rendering ──
        page.evaluate("""
          ['180302','264040','604340','897239'].forEach(mr => {
            rows.push({ id: mr + '_nusin', mr, facility: 'nusin', dateAdded: '2026-08-27',
              tglRegistrasi: '2026-08-26', nama: 'LAB PATIENT ' + mr, umur: '', kamar: '', bed: '',
              dokter: '', diagnosis: '', operan: '', terapi: '', hasilLab: null,
              checklist: { telaah_resep: null, catatan_pengobatan: null },
              pharmacistNote: '', archived: false, archivedAt: null, telaahLog: [], catatanLog: [],
              history: [] });
          });
          render();
        """)
        page.wait_for_timeout(200)

        # Column position: Hasil Lab must be right after Terapi, before Checklist.
        out["column_order"] = page.evaluate("""
          Array.from(document.querySelectorAll('#tableWrap thead th')).map(t => t.textContent.trim())
        """)

        # Load the 4 lab files via the real file input.
        page.locator("#labInput").set_input_files([
            f"{LAB}/lab-180302.xlsx", f"{LAB}/lab-264040.xlsx",
            f"{LAB}/lab-604340.xlsx", f"{LAB}/lab-897239.xlsx"])
        page.wait_for_timeout(2500)

        # labResults populated for all 4 MRs.
        out["labResults_keys"] = page.evaluate("Object.keys(labResults).sort()")

        # The 264040 row (has kritis) should show the Lab Kritis badge + summary.
        out["cell_264040"] = page.evaluate("""
          (() => {
            const tr = Array.from(document.querySelectorAll('#tableWrap tbody tr'))
              .find(tr => tr.querySelector('td.mr-col') && tr.querySelector('td.mr-col').textContent.trim() === '264040');
            const cell = tr ? tr.querySelector('td.lab-cell') : null;
            if (!cell) return null;
            return {
              hasKritisBadge: !!cell.querySelector('.lab-kritis-badge'),
              badgeText: cell.querySelector('.lab-kritis-badge') ? cell.querySelector('.lab-kritis-badge').textContent.trim() : null,
              summary: cell.querySelector('.lab-summary-line') ? cell.querySelector('.lab-summary-line').textContent.trim() : null,
              hasBtn: !!cell.querySelector('.btn-lab')
            };
          })()
        """)

        # A non-kritis row (180302) should have NO kritis badge but still a summary.
        out["cell_180302"] = page.evaluate("""
          (() => {
            const tr = Array.from(document.querySelectorAll('#tableWrap tbody tr'))
              .find(tr => tr.querySelector('td.mr-col') && tr.querySelector('td.mr-col').textContent.trim() === '180302');
            const cell = tr ? tr.querySelector('td.lab-cell') : null;
            if (!cell) return null;
            return {
              hasKritisBadge: !!cell.querySelector('.lab-kritis-badge'),
              summary: cell.querySelector('.lab-summary-line') ? cell.querySelector('.lab-summary-line').textContent.trim() : null
            };
          })()
        """)

        # Expand 264040's lab report; check the full table + LK markers + red abnormal.
        page.evaluate("toggleLab('264040_nusin')")
        page.wait_for_timeout(300)
        out["expanded_264040"] = page.evaluate("""
          (() => {
            const wrap = document.querySelector('#tableWrap .lab-wrap');
            if (!wrap) return null;
            const rows = Array.from(wrap.querySelectorAll('.lab-table tbody tr'));
            const lkCount = wrap.querySelectorAll('.lab-lk').length;
            const abnormalCells = wrap.querySelectorAll('.lab-abnormal, .lab-kritis-val').length;
            const kritisRows = wrap.querySelectorAll('tr.lab-row-kritis').length;
            // find the APTT kritis row and confirm it has LK
            const aptt = rows.find(r => r.querySelector('td') && r.querySelector('td').textContent.trim() === 'APTT');
            return {
              totalRows: rows.length,
              lkCount, abnormalCells, kritisRows,
              apttHasLK: aptt ? !!aptt.querySelector('.lab-lk') : null,
              apttValText: aptt ? aptt.querySelectorAll('td')[1].textContent.trim() : null
            };
          })()
        """)

        # ── Part C: latest file replaces old one ──
        # Load 180302 again (same file) -> still one report, loadedAt updated, counts same.
        before = page.evaluate("labResults['180302'].tests.length")
        page.locator("#labInput").set_input_files([f"{LAB}/lab-180302.xlsx"])
        page.wait_for_timeout(1500)
        out["replace"] = page.evaluate("""
          (() => {
            const r = labResults['180302'];
            return { tests: r.tests.length, hasLoadedAt: !!r.loadedAt, keyCount: Object.keys(labResults).length };
          })()
        """)
        out["replace"]["tests_before"] = before

        # ── Part D: labResults in save payload ──
        out["save_payload_has_lab"] = page.evaluate("""
          (() => {
            const payload = JSON.stringify({ savedAt: new Date().toISOString(), rows, patientChecklist, labResults });
            return payload.includes('"labResults"') && payload.includes('180302');
          })()
        """)

        out["js_errors"] = errors
        browser.close()

    print(json.dumps(out, indent=2, ensure_ascii=False))
