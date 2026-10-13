"""Verify the current local-file save/export behavior (file:// mode, isServerMode=false):
- Save All Data with a bound handle overwrites the SAME file in place (no new file).
- Save All Data with NO bound handle opens the picker with master_data.json pre-filled.
- Export Snapshot with a bound handle (dir access) writes a NEW timestamped file
  next to the bound file (rekap-visite-master-YYYY-MM-DD-HH-MM-SS.json).
- Export Snapshot with no dir access falls back to the save picker with the
  timestamped name pre-filled.
"""
import json, re, os
from playwright.sync_api import sync_playwright

from conftest import HERE  # noqa: E402
# This test exercises the LOCAL-FILE save path (File System Access API), which
# only runs when the app is NOT in server mode. So open index.html as a file://
# URL (isServerMode === false) rather than via the http test server.
FILE_URL = "file://" + os.path.join(HERE, "index.html")
PATTERN = re.compile(r"^rekap-visite-master-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$")

INIT = """
window.__mockDir = { files: {}, getFileHandle(name, opts) {
  if (opts && opts.create) this.files[name] = { name, content: null,
    queryPermission: async () => 'granted',
    getParentDirectory: async () => window.__mockDir,
    createWritable: async () => ({
      write: async (d) => { this.files[name].content = d; window.__written = d; },
      close: async () => {} }) };
  if (!this.files[name]) throw new Error('not found: ' + name);
  return this.files[name];
}};
window.__pickerSuggested = null;
window.__written = null;
window.showSaveFilePicker = async (opts) => {
  window.__pickerSuggested = opts.suggestedName;
  return { name: opts.suggestedName, createWritable: async () => ({
    write: async (d) => { window.__written = d; }, close: async () => {} }) };
};
"""

def test_main():
    """Run the verification script body (module-level code)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.add_init_script(INIT)
        page.goto(FILE_URL, wait_until="domcontentloaded")
        page.wait_for_timeout(400)

        out = {}

        # Seed some rows so the payload is non-trivial.
        page.evaluate("""
          rows = [{ id: '1_nusin', mr: '1', facility: 'nusin', dateAdded: '2026-08-28',
                   nama: 'TEST', checklist: {}, pharmacistNote: '', archived: false,
                   history: [] }];
          patientChecklist = { '1': {} };
        """)

        # ── 1. Save All Data with a bound handle -> overwrites the SAME file in place ──
        page.evaluate("""
          window.__mockDir.files['master_data.json'] = { name: 'master_data.json', content: null,
            queryPermission: async () => 'granted',
            getParentDirectory: async () => window.__mockDir,
            createWritable: async () => ({
              write: async (d) => { window.__mockDir.files['master_data.json'].content = d; window.__written = d; },
              close: async () => {} }) };
          masterFileHandle = window.__mockDir.files['master_data.json'];
        """)
        page.evaluate("saveAllData()")
        page.wait_for_timeout(500)
        out["save_inplace_files"] = page.evaluate("Object.keys(window.__mockDir.files)")
        out["save_inplace_ok"] = out["save_inplace_files"] == ["master_data.json"]
        payload = page.evaluate("window.__written")
        data = json.loads(payload)
        out["save_payload_rows"] = len(data["rows"])
        out["save_payload_savedAt"] = bool(data["savedAt"])
        out["save_toast"] = page.evaluate("document.getElementById('toast').textContent")

        # ── 2. Save All Data with NO bound handle -> picker with master_data.json ──
        page.evaluate("masterFileHandle = null; window.__pickerSuggested = null;")
        page.evaluate("saveAllData()")
        page.wait_for_timeout(500)
        out["save_picker_suggested"] = page.evaluate("window.__pickerSuggested")
        out["save_picker_ok"] = out["save_picker_suggested"] == "master_data.json"

        # ── 3. Export Snapshot with a bound handle (dir access) -> NEW timestamped file ──
        page.evaluate("""
          window.__pickerSuggested = null;
          masterFileHandle = window.__mockDir.files['master_data.json'];
        """)
        page.evaluate("exportSnapshot()")
        page.wait_for_timeout(500)
        out["snap_files"] = page.evaluate("Object.keys(window.__mockDir.files)")
        out["snap_new_file"] = [n for n in out["snap_files"] if n != "master_data.json"]
        out["snap_ok"] = (len(out["snap_new_file"]) == 1
                          and bool(PATTERN.match(out["snap_new_file"][0])))
        out["snap_bound_untouched"] = "master_data.json" in out["snap_files"]

        # ── 4. Export Snapshot with no dir access -> picker with timestamped name ──
        page.evaluate("""
          window.__pickerSuggested = null;
          masterFileHandle = {
            name: 'master_data.json',
            queryPermission: async () => 'granted',
            getParentDirectory: async () => { throw new Error('SecurityError'); },
            createWritable: async () => { throw new Error('should not be used'); }
          };
        """)
        page.evaluate("exportSnapshot()")
        page.wait_for_timeout(500)
        out["snap_picker_suggested"] = page.evaluate("window.__pickerSuggested")
        out["snap_picker_ok"] = bool(PATTERN.match(out["snap_picker_suggested"] or ""))

        out["js_errors"] = errors
        browser.close()

    print(json.dumps(out, indent=2, ensure_ascii=False))
    ok = (out["save_inplace_ok"] and out["save_payload_rows"] == 1
          and out["save_payload_savedAt"] and out["save_picker_ok"]
          and out["snap_ok"] and out["snap_bound_untouched"]
          and out["snap_picker_ok"] and not out["js_errors"])
    print("ALL SAVE/EXPORT CHECKS PASS" if ok else "SAVE/EXPORT CHECKS FAILED")
    assert ok, "save/export checks failed: " + json.dumps(out, ensure_ascii=False)
