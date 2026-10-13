"""Verify copyLab works in BOTH contexts:
A) NON-secure (plain http via LAN IP): navigator.clipboard is undefined —
   the execCommand fallback must kick in and copy the filtered entries.
B) Secure (localhost): navigator.clipboard path still works.
Format: "Nama Pemeriksaan<space>Hasil" per line, matching visible (filtered) rows.
"""
import json
from playwright.sync_api import sync_playwright

from conftest import BASE  # noqa: E402
LAB = "/home/rezza/projects/rekap-visite-nusin/data/lab"
SEED = """
  rows.push({ id: '264040_nusin', mr: '264040', facility: 'nusin', dateAdded: '2026-08-27',
    tglRegistrasi: '2026-08-26', nama: 'LAB PATIENT 264040', umur: '', kamar: '', bed: '',
    dokter: '', diagnosis: '', operan: '', terapi: '', hasilLab: null,
    checklist: { telaah_resep: null, catatan_pengobatan: null },
    pharmacistNote: '', archived: false, archivedAt: null, telaahLog: [], catatanLog: [], history: [] });
  render();
"""
EXPECTED = """
  (() => {
    const rep = labResults['264040'];
    const f = t => t.nama + ' ' + t.hasil;
    return {
      all: rep.tests.map(f),
      abn: rep.tests.filter(t => t.abnormal).map(f),
      kri: rep.tests.filter(t => t.kritis).map(f)
    };
  })()
"""

def run_case(p, base, secure, label):
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    if secure:
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    else:
        # Capture what the execCommand fallback copies (clipboard readText
        # is unavailable in non-secure contexts).
        ctx.add_init_script("""
          window.__execCopied = null;
          const origExec = document.execCommand.bind(document);
          document.execCommand = (cmd, ...args) => {
            if (cmd === 'copy') {
              const ta = document.activeElement;
              if (ta && ta.tagName === 'TEXTAREA') window.__execCopied = ta.value;
            }
            return origExec(cmd, ...args);
          };
        """)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base + "/index.html", wait_until="domcontentloaded")
    page.wait_for_timeout(1500)

    out = {"secure_context": page.evaluate("window.isSecureContext"),
           "clipboard_api_present": page.evaluate("!!(navigator.clipboard && navigator.clipboard.writeText)")}
    assert out["secure_context"] == secure, f"{label}: context mismatch"

    page.evaluate(SEED)
    page.wait_for_timeout(200)
    page.locator("#labInput").set_input_files([f"{LAB}/lab-264040.xlsx"])
    page.wait_for_timeout(2000)
    page.evaluate("toggleLab('264040_nusin')")
    page.wait_for_timeout(300)
    exp = page.evaluate(EXPECTED)

    def read_clip():
        if secure:
            return page.evaluate("navigator.clipboard.readText()")
        return page.evaluate("window.__execCopied")

    def click_copy():
        page.locator(".lab-title .btn-copy").click()
        page.wait_for_timeout(400)

    # 1. No filter -> all tests
    click_copy()
    got = read_clip()
    out["copy_all"] = {"count": len(got.split("\n")) if got else 0,
                       "expected_count": len(exp["all"]),
                       "match": got == "\n".join(exp["all"]),
                       "first_line": got.split("\n")[0] if got else None}

    # 2. Abnormal filter
    page.locator(".lab-filter-bar .filter-btn", has_text="Abnormal").click()
    page.wait_for_timeout(300)
    click_copy()
    got = read_clip()
    out["copy_abnormal"] = {"count": len(got.split("\n")) if got else 0,
                            "expected_count": len(exp["abn"]),
                            "match": got == "\n".join(exp["abn"])}

    # 3. Kritis filter only
    page.locator(".lab-filter-bar .filter-btn", has_text="Abnormal").click()
    page.locator(".lab-filter-bar .filter-btn", has_text="Kritis").click()
    page.wait_for_timeout(300)
    click_copy()
    got = read_clip()
    out["copy_kritis"] = {"count": len(got.split("\n")) if got else 0,
                          "expected_count": len(exp["kri"]),
                          "match": got == "\n".join(exp["kri"]),
                          "lines": got.split("\n") if got else None}

    # 4. Toast feedback
    out["toast"] = page.evaluate("document.querySelector('.toast') ? document.querySelector('.toast').textContent : null")
    out["js_errors"] = errors
    browser.close()
    return out

def test_main():
    """Run the verification script body (module-level code)."""
    with sync_playwright() as p:
        results = {
            "A_nonsecure_lan_ip": run_case(p, BASE.replace("localhost", "192.168.1.24"), False, "A"),
            "B_secure_localhost": run_case(p, BASE, True, "B"),
        }

    ok = all(results[k][m]["match"] for k in results for m in ("copy_all", "copy_abnormal", "copy_kritis"))
    results["ALL_PASS"] = ok
    print(json.dumps(results, indent=2, ensure_ascii=False))
    assert ok, "copylab checks failed: " + json.dumps(results, ensure_ascii=False)
