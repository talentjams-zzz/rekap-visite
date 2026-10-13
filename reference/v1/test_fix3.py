"""Verify the 3 fixes:
1. Auto-archive when a facility's latest file has 0 patients (observasi bug).
   Seed an active observasi row, then load an EMPTY observasi registry file
   (header only, no patients) -> the row must be auto-archived; other
   facilities unaffected.
2. GD Sewaktu (POCT) normal override to 70-139.
3. Column widths saved to master JSON (colWidths in payload + restored on load).
"""
import json
from playwright.sync_api import sync_playwright

from conftest import BASE, DATA  # noqa: E402
ROOT = "/home/rezza/projects/rekap-visite-nusin"
# Empty observasi registry file (title + header rows, zero patients).
OBS_EMPTY = f"{DATA}/observasi-04-09-26-update.xlsx"
LAB = f"{ROOT}/data/lab"


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

        # ── 1. Seed an ACTIVE observasi row, then load the empty file ──
        page.evaluate("""
          rows.push({ id: '894940_observasi', mr: '894940', facility: 'observasi',
            dateAdded: '2026-09-03', lastSeen: '2026-09-03 08:00:00',
            tglRegistrasi: '2026-09-02', nama: 'OBS TEST 894940', umur: '', kamar: '',
            bed: '', dokter: '', diagnosis: '', operan: '', terapi: '', hasilLab: null,
            checklist: { telaah_resep: null, catatan_pengobatan: null },
            pharmacistNote: '', archived: false, archivedAt: null,
            telaahLog: [], catatanLog: [], history: [] });
          // A nusin row that must NOT be affected by the observasi load.
          rows.push({ id: '111111_nusin', mr: '111111', facility: 'nusin',
            dateAdded: '2026-09-03', lastSeen: '2026-09-03 08:00:00',
            tglRegistrasi: '2026-09-02', nama: 'NUSIN TEST 111111', umur: '', kamar: '',
            bed: '', dokter: '', diagnosis: '', operan: '', terapi: '', hasilLab: null,
            checklist: { telaah_resep: null, catatan_pengobatan: null },
            pharmacistNote: '', archived: false, archivedAt: null,
            telaahLog: [], catatanLog: [], history: [] });
          render();
        """)
        page.wait_for_timeout(200)
        out["before_obs_empty"] = page.evaluate("""
          (() => {
            const obs = rows.find(r => r.mr === '894940' && r.facility === 'observasi');
            const nus = rows.find(r => r.mr === '111111' && r.facility === 'nusin');
            return { obsArchived: obs.archived, nusArchived: nus.archived };
          })()
        """)

        # Load the empty observasi file -> 894940 must be auto-archived.
        page.locator("#excelInput").set_input_files([OBS_EMPTY])
        page.wait_for_timeout(2500)
        out["after_obs_empty"] = page.evaluate("""
          (() => {
            const obs = rows.find(r => r.mr === '894940' && r.facility === 'observasi');
            const nus = rows.find(r => r.mr === '111111' && r.facility === 'nusin');
            return {
              obsArchived: obs ? obs.archived : null,
              nusArchived: nus ? nus.archived : null,
              facilityLatestInput_obs: facilityLatestInput['observasi']
            };
          })()
        """)

        # ── 2. GD Sewaktu (POCT) override ──
        out["gd"] = page.evaluate("""
          (async () => {
            const res = {};
            for (const f of ['lab-180302.xlsx','lab-264040.xlsx','lab-604340.xlsx','lab-897239.xlsx']) {
              const buf = await (await fetch('/data/lab/' + f)).arrayBuffer();
              const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
              const rep = parseLabFile(wb);
              const gd = rep.tests.filter(t => /gd\\s+sewaktu/i.test(t.nama));
              res[f] = gd.map(t => ({ nama: t.nama, hasil: t.hasil, normal: t.normal, abnormal: t.abnormal }));
            }
            return res;
          })()
        """)

        # ── 3. colWidths in save payload + restored on load ──
        page.evaluate("colWidths.nama = 333; saveColWidths();")
        out["colWidths_in_payload"] = page.evaluate("""
          (() => {
            const payload = JSON.stringify({ savedAt: new Date().toISOString(), rows, patientChecklist, labResults, colWidths });
            return { hasColWidths: payload.includes('"colWidths"'), namaWidth: JSON.parse(payload).colWidths.nama };
          })()
        """)
        out["colWidths_roundtrip"] = page.evaluate("""
          (() => {
            const payload = JSON.stringify({ savedAt: new Date().toISOString(), rows, patientChecklist, labResults, colWidths });
            const data = JSON.parse(payload);
            colWidths = {};
            applyMasterData(data);
            return { restoredNama: colWidths.nama, localStorageNama: JSON.parse(localStorage.getItem('rekap-col-widths')||'{}').nama };
          })()
        """)

        out["js_errors"] = errors
        browser.close()

    print(json.dumps(out, indent=2, ensure_ascii=False))
