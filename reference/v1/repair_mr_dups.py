"""Repair leading-zero MR duplicates in master_data.json.

A numeric MEDREC in an Excel export drops the leading zero (067016 -> 67016),
which created a duplicate row. This merges each duplicate (short-MR) row into
its canonical (zero-padded) twin:
  - canonical.operan/diagnosis/terapi <- duplicate's (the newer handover values)
  - canonical.history <- merged with duplicate's history (fill empty fields on
    shared dates, add missing dates; NEVER overwrite existing non-empty data)
  - duplicate row is deleted
Registry fields (nama/umur/kamar/bed/dokter/tglRegistrasi), checklist, archive
state, lastSeen, dateAdded, logs all stay on the canonical row.

Run with --apply to write; default is a dry run that only reports.
"""
import json, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "master_data.json")
CLINICAL = ["operan", "diagnosis", "terapi"]
HIST_FIELDS = ["operan", "diagnosis", "terapi", "nama", "kamar", "bed", "dokter"]

def digits(mr):
    return str(mr).lstrip("0") or "0"

def main():
    apply = "--apply" in sys.argv
    with open(PATH) as f:
        data = json.load(f)
    rows = data["rows"]

    # Group rows by (facility, digit-string). A group with >1 row is a duplicate set.
    groups = {}
    for r in rows:
        groups.setdefault((r["facility"], digits(r["mr"])), []).append(r)
    dup_groups = {k: v for k, v in groups.items() if len(v) > 1}
    print(f"Duplicate groups found: {len(dup_groups)}")

    to_delete = []
    for (facility, dg), members in sorted(dup_groups.items()):
        # canonical = the zero-padded (longest) MR; dup = the short one
        members_sorted = sorted(members, key=lambda r: len(r["mr"]), reverse=True)
        C = members_sorted[0]
        D = members_sorted[1] if len(members_sorted) > 1 else None
        if D is None:
            continue
        print(f"\n{facility} / digits {dg}: canonical {C['mr']}  <-  dup {D['mr']}")
        # 1. Clinical current fields: take dup's if non-empty
        for fld in CLINICAL:
            dv = (D.get(fld) or "").strip()
            cv = (C.get(fld) or "").strip()
            if dv and dv != cv:
                print(f"   {fld}: {cv[:35]!r} -> {dv[:35]!r}")
                if apply:
                    C[fld] = D[fld]
        # 2. Merge history
        chist = {h["date"]: h for h in C.get("history", [])}
        added = 0; filled = 0
        for dh in D.get("history", []):
            cd = chist.get(dh["date"])
            if cd is None:
                if apply:
                    C.setdefault("history", []).append(dict(dh))
                added += 1
                print(f"   hist {dh['date']}: ADDED (operan={str(dh.get('operan'))[:30]!r})")
            else:
                for fld in HIST_FIELDS:
                    cv = cd.get(fld)
                    dv = dh.get(fld)
                    if (cv is None or str(cv).strip() == "") and dv is not None and str(dv).strip() != "":
                        if apply:
                            cd[fld] = dv
                        filled += 1
                        print(f"   hist {dh['date']} {fld}: filled {str(dv)[:30]!r}")
        if apply:
            C["history"].sort(key=lambda h: str(h["date"]), reverse=True)
        print(f"   history: {added} added, {filled} fields filled")
        to_delete.append(D["id"])

    if apply:
        before = len(rows)
        data["rows"] = [r for r in rows if r["id"] not in set(to_delete)]
        after = len(data["rows"])
        with open(PATH, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"\nAPPLIED: removed {before - after} duplicate rows ({before} -> {after})")
        # verify no leading-zero dups remain
        g2 = {}
        for r in data["rows"]:
            g2.setdefault((r["facility"], digits(r["mr"])), []).append(r)
        remaining = {k: v for k, v in g2.items() if len(v) > 1}
        print(f"Remaining duplicate groups: {len(remaining)}")
    else:
        print(f"\nDRY RUN: would remove {len(to_delete)} rows: {to_delete}")
        print("Re-run with --apply to write.")

if __name__ == "__main__":
    main()
