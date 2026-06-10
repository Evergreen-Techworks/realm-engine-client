#!/usr/bin/env python3
"""
Apply a beebyte offset-update payload to RuntimeOffsets.cpp/.h.

Invoked by .github/workflows/beebyte-offset-update.yml when the realm-engine
beebyte daily scan dispatches a `beebyte-offsets` repository_dispatch event.
Can also be run by hand against a local payload JSON.

Payload shape (client_payload of the dispatch event):
  {
    "build_hash": "<sha256 of the trace this came from>",
    "shifted": [
      {"class": "ObjectProperties", "field": "isEnemy",
       "old": "0x6c9", "new": "0x6d1"},
      ...
    ],
    "unresolved_classes": ["HBEAKBIHANL", ...],          # informational
    "missing_fields": [                                   # informational
      {"class": "ProjectileProperties", "field": "Magnitude",
       "fallback": "0x194"},
      ...
    ]
  }

What it does:
  1. Parses the s_entries resolution table in RuntimeOffsets.cpp to map
     (className, tryName) -> the uint32_t variable that stores the offset.
  2. For every "shifted" entry that maps to a variable, rewrites the
     variable's fallback initialiser in RuntimeOffsets.cpp to the live
     value. The logged resolved value already includes the ACTK shift,
     so it is written verbatim.
  3. Best-effort: updates a "fallback 0xNNN" annotation on the variable's
     extern line in RuntimeOffsets.h if one exists.
  4. Prints a markdown summary (applied / unmapped / informational) to
     stdout — the workflow uses it as the PR body.

Exit codes: 0 = ran (changes or not; workflow checks `git diff`),
            2 = payload invalid.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
OFFSETS_CPP = REPO_ROOT / "internal/src/core/runtime/RuntimeOffsets.cpp"
OFFSETS_H = REPO_ROOT / "internal/src/core/runtime/RuntimeOffsets.h"

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
HEX_RE = re.compile(r"^0x[0-9A-Fa-f]{1,8}$")

# One s_entries row, possibly spanning lines:
#   { "ObjectProperties", { "isEnemy" },        1, 0,     &OP_IsEnemy, false },
#   { "ObjectProperties", { "protectFromSink",
#                            "ProtectFromSink" }, 2, 0,   &OP_ProtSink, false },
ENTRY_RE = re.compile(
    r'\{\s*"(?P<cls>[^"]+)"\s*,\s*\{(?P<names>[^{}]*)\}\s*,\s*\d+\s*,\s*'
    r'(?:kActk|0x[0-9A-Fa-f]+u?|\d+u?)\s*,\s*&(?P<var>\w+)\s*,\s*\w+\s*\}',
    re.DOTALL,
)
QUOTED_RE = re.compile(r'"([^"]+)"')


def parse_entry_map(cpp_text: str) -> dict[tuple[str, str], str]:
    """{(className, tryName): varName} from the s_entries table."""
    out: dict[tuple[str, str], str] = {}
    for m in ENTRY_RE.finditer(cpp_text):
        cls, var = m.group("cls"), m.group("var")
        for name in QUOTED_RE.findall(m.group("names")):
            out[(cls, name)] = var
    return out


def rewrite_cpp_fallback(cpp_text: str, var: str, new_hex: str) -> tuple[str, str | None]:
    """Rewrite `uint32_t <var> = 0x...;` -> new value. Returns (text, old) —
    old is None when the definition wasn't found."""
    pat = re.compile(
        r"^(?P<lead>uint32_t\s+" + re.escape(var) + r"\s*=\s*)(?P<old>0x[0-9A-Fa-f]+|\d+)(?P<tail>\s*;)",
        re.MULTILINE,
    )
    m = pat.search(cpp_text)
    if not m:
        return cpp_text, None
    return pat.sub(lambda mm: mm.group("lead") + new_hex + mm.group("tail"), cpp_text, count=1), m.group("old")


def rewrite_h_comment(h_text: str, var: str, new_hex: str) -> str:
    """On the `extern uint32_t <var>;` line, refresh a `fallback 0x...`
    annotation if present. Best-effort only."""
    lines = h_text.splitlines(keepends=True)
    decl = re.compile(r"\bextern\s+uint32_t\s+" + re.escape(var) + r"\s*;")
    fall = re.compile(r"(fallback\s+)0x[0-9A-Fa-f]+")
    for i, line in enumerate(lines):
        if decl.search(line) and fall.search(line):
            lines[i] = fall.sub(lambda m: m.group(1) + new_hex, line, count=1)
            break
    return "".join(lines)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: apply-offset-update.py <payload.json>", file=sys.stderr)
        return 2
    try:
        payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"cannot read payload: {e}", file=sys.stderr)
        return 2

    shifted = payload.get("shifted") or []
    for row in shifted:
        if not (isinstance(row, dict)
                and NAME_RE.match(str(row.get("class", "")))
                and NAME_RE.match(str(row.get("field", "")))
                and HEX_RE.match(str(row.get("new", "")))
                and HEX_RE.match(str(row.get("old", "")))):
            print(f"invalid shifted row rejected: {row!r}", file=sys.stderr)
            return 2

    cpp_text = OFFSETS_CPP.read_text(encoding="utf-8")
    h_text = OFFSETS_H.read_text(encoding="utf-8")
    entry_map = parse_entry_map(cpp_text)

    applied: list[str] = []
    noop: list[str] = []
    unmapped: list[str] = []

    for row in shifted:
        cls, fld = row["class"], row["field"]
        new_hex = "0x" + row["new"][2:].upper()
        var = entry_map.get((cls, fld))
        if not var:
            unmapped.append(f"`{cls}::{fld}` -> {new_hex} (no s_entries mapping)")
            continue
        cpp_text, old = rewrite_cpp_fallback(cpp_text, var, new_hex)
        if old is None:
            unmapped.append(f"`{cls}::{fld}` -> {new_hex} (variable `{var}` definition not found)")
        elif int(old, 0) == int(new_hex, 16):
            noop.append(f"`{var}` already {new_hex}")
        else:
            h_text = rewrite_h_comment(h_text, var, new_hex)
            applied.append(f"`{var}` ({cls}::{fld}): {old} -> {new_hex}")

    OFFSETS_CPP.write_text(cpp_text, encoding="utf-8")
    OFFSETS_H.write_text(h_text, encoding="utf-8")

    # ── PR-body markdown on stdout ──────────────────────────────────────
    print("## Automated offset update from the beebyte daily scan\n")
    print(f"Trace build hash: `{payload.get('build_hash', 'unknown')}`\n")
    if applied:
        print("### Fallbacks updated (live-resolver verified)")
        print("\n".join(f"- {s}" for s in applied) + "\n")
    if noop:
        print("### Already current")
        print("\n".join(f"- {s}" for s in noop) + "\n")
    if unmapped:
        print("### NOT applied — needs a human")
        print("\n".join(f"- {s}" for s in unmapped) + "\n")
    if payload.get("unresolved_classes"):
        print("### Classes that no longer resolve (BeeByte renamed — fresh dump needed)")
        print("\n".join(f"- `{c}`" for c in payload["unresolved_classes"]
                        if NAME_RE.match(str(c))) + "\n")
    if payload.get("missing_fields"):
        print("### Field names missing from metadata (renamed/removed — fallbacks in use)")
        print("\n".join(
            f"- `{r.get('class')}::{r.get('field')}` (fallback {r.get('fallback')})"
            for r in payload["missing_fields"]
            if isinstance(r, dict) and NAME_RE.match(str(r.get("class", "")))
            and NAME_RE.match(str(r.get("field", "")))) + "\n")
    print("> Fallbacks only matter during the 5s resolver give-up window; "
          "the runtime resolver self-corrects named fields every session. "
          "Review the diff, then merge.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
