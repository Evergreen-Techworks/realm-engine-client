"""Build the UDodge scenario harness against one source tree and run every scenario.

    python3 run_scenarios.py --internal /path/to/internal [--label NAME] [--only SCENARIO]

The harness file and stubs always come from THIS checkout; the dodge sources come
from --internal, so the same scenarios can be run against an older tree. Each
scenario runs in its own process. Prints one JSON object per scenario.

    python3 run_scenarios.py --table                  # baseline table, every scenario, both rules
    python3 run_scenarios.py --tactician-acceptance   # Tactician thresholds; red until it lands

    python3 run_scenarios.py --telemetry-check         # decision telemetry: off is silent, on explains

--table prints one markdown row per scenario and rule, known limitations included.
--tactician-acceptance is a separate entry point: --check never evaluates it and
the host suite (run_udodge_zone_tests.py) never runs it.
--telemetry-check runs the production UDodge::Tick with field diagnostics off and on
(HARNESS_DIAG, which forces DiagTiming on the way RE_ASSETS/diag-timing.flag does in
game) and checks the [Diag/Nav] decision lines. The host suite runs it.
"""
from pathlib import Path
import argparse, json, os, re, shutil, subprocess, sys, tempfile

HERE = Path(__file__).resolve().parent
# Known limitations: reported, never asserted. A locked boss firing a dense ring
# plus aimed volleys keeps the player at the edge of the rings' reach — the solver
# ranks safety over range — so these reach no engagement range today.
# m_pinch_nowalk: the game's collision is a point test (HJMBOMEHGDJ::PEGDEDNHEHD), so it
# lets the player through a corner where two NoWalk / OccupySquare squares touch
# diagonally. The DLL's occupancy keeps a 0.2285 box, the nav A* refuses corner
# cuts and the follower pads its sweep, so today the route never takes that corner.
# m_pinch_object: the same corner between two OccupySquare objects.
# Under navCollisionRule=game the DLL uses the game's point rule, so both pinches pass.
# d_boss_*_dense_x065 / _x100 are the same two fights in the two worlds that matter
# (the owner's armed collider and the game's default hit box) — the same known
# limitation, reported under both policies and never asserted.
DENSE_VARIANTS = ["d_boss_open_dense_x100", "d_boss_wall_dense_x100",
                  "d_boss_open_dense_x065", "d_boss_wall_dense_x065"]
KNOWN_LIMITATIONS = {
    "legacy": {"d_boss_open_dense", "d_boss_wall_dense", "m_pinch_nowalk", "m_pinch_object", *DENSE_VARIANTS},
    "game":   {"d_boss_open_dense", "d_boss_wall_dense", *DENSE_VARIANTS},
}

SCENARIOS = [
    "a_lake_deep_speed", "a_lake_deep_plain", "a_lake_shallow", "a_river_deep_speed", "a_river_shallow",
    "b_tree_cluster", "b_tree_cluster2",
    "c_u_wall", "c_u_wall_lock",
    "d_boss_open_rings", "d_boss_wall_rings", "d_boss_open_dense", "d_boss_wall_dense",
    "d_boss_open_dense_x100", "d_boss_wall_dense_x100", "d_boss_open_dense_x065", "d_boss_wall_dense_x065",
    "e_corridor1_nowalk", "e_corridor1_fullocc", "e_corridor2_fullocc",
    "f_damaging_row", "f_lava_detour", "f_lava_pressure", "g_fullocc_gap", "h_learned_keepout", "j_hidden_blocker",
    "i_tilelist_revisit", "i_tilelist_frontier",
    "k_slowed_midwalk", "k_paralyzed_midwalk", "k_water_midpath", "k_dodge_in_water",
    "k_speedy_walk", "k_slowed_water", "k_mixed_water_land",
    "l_walk_past_shotgun", "l_walk_past_bomber", "l_lock_boss_dies", "l_lock_boss_invuln",
    "m_pinch_nowalk", "m_pinch_fulloccupy", "m_pinch_object",
    "p_walk_through_pack", "p_lock_boss_standoff",
    "z_moveto_no_clamp",
    "n_rooms1_nowalk_forward", "n_rooms1_nowalk_reverse",
    "n_rooms2_nowalk_forward", "n_rooms2_nowalk_reverse",
    "n_rooms1_fullocc_forward", "n_rooms1_fullocc_reverse",
    "n_rooms2_fullocc_forward", "n_rooms2_fullocc_reverse",
    "n_rooms_reveal_forward", "n_rooms_reveal_reverse",
    "o_pending_map_waypoint", "o_pending_map_blocked",
]

STAGE2_REGRESSIONS = ["n_rooms_remote_forward", "n_rooms_remote_reverse"]

# Tactician acceptance (docs/superpowers/specs/2026-09-18-tactician-design.md, "Acceptance").
# A boss scenario is one the harness runs with an enemy lock (its row says "lock": true).
BOSS_SCENARIOS = [
    "c_u_wall_lock", "p_lock_boss_standoff", "d_boss_open_rings", "d_boss_wall_rings", "d_boss_open_dense", "d_boss_wall_dense",
    *DENSE_VARIANTS,
    "l_lock_boss_dies", "l_lock_boss_invuln",
]
TACTICIAN_IN_RANGE_MIN = {"d_boss_open_dense": 0.60, "d_boss_wall_dense": 0.50,
                          "d_boss_open_dense_x100": 0.60, "d_boss_wall_dense_x100": 0.50,
                          "d_boss_open_dense_x065": 0.60, "d_boss_wall_dense_x065": 0.50}   # with hits == 0
TACTICIAN_RADIAL_OUT_MAX = 0.10   # every boss scenario (ledger ruling 2026-09-18; was 0.15)
TACTICIAN_REPLANS_MAX = 2.0       # every boss scenario, per second
TACTICIAN_REVERSALS_MAX = 0.5     # every boss scenario, per second (ledger ruling 2026-09-18)

TABLE_COLUMNS = {   # column -> decimals, in table order
    "hits": 0, "in_range_frac": 2, "radial_out_frac": 4, "replans_per_s": 3, "time_to_first_in_range_s": 2,
    "path_tiles": 1, "stuck_s": 1, "threat_move_tiles": 1, "heading_reversals_per_s": 2,
}
LOCK_ONLY_COLUMNS = {"in_range_frac", "radial_out_frac", "time_to_first_in_range_s", "threat_move_tiles"}


def format_table(rows):
    """One markdown row per scenario and rule. A column that needs a lock prints "-" without one."""
    lines = ["| scenario | rule | result | " + " | ".join(TABLE_COLUMNS) + " |",
             "|---|---|---|" + "---:|" * len(TABLE_COLUMNS)]
    for row in rows:
        if row["success"]:
            result = "pass"
        else:
            result = "known" if row["scenario"] in KNOWN_LIMITATIONS[row["rule"]] else "FAIL"
        cells = ["-" if column in LOCK_ONLY_COLUMNS and not row["lock"] else f"{row[column]:.{decimals}f}"
                 for column, decimals in TABLE_COLUMNS.items()]
        lines.append(f"| {row['scenario']} | {row['rule']} | {result} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def tactician_acceptance(rows, rules):
    """The spec's thresholds over the boss scenarios. Returns (passed, failed) lists of text lines."""
    passed, failed = [], []
    by_key = {(row["scenario"], row["rule"]): row for row in rows}

    def judge(ok, text):
        (passed if ok else failed).append(text)

    for rule in rules:
        for name in BOSS_SCENARIOS:
            row = by_key.get((name, rule))
            if row is None:
                failed.append(f"{name} [{rule}]: no result")
                continue
            if not row.get("lock"):
                failed.append(f"{name} [{rule}]: the harness did not run it with a lock")
                continue
            if name in TACTICIAN_IN_RANGE_MIN:
                need = TACTICIAN_IN_RANGE_MIN[name]
                tail = row["in_range_tail_frames"]
                frac = row["in_range_frames"] / tail if tail else 0.0   # exact, not the 2-decimal field
                judge(row["hits"] == 0, f"{name} [{rule}]: hits {row['hits']} (required 0)")
                judge(frac >= need, f"{name} [{rule}]: in_range_frac {frac:.4f} (required >= {need:.2f})")
            judge(row["radial_out_frac"] <= TACTICIAN_RADIAL_OUT_MAX,
                  f"{name} [{rule}]: radial_out_frac {row['radial_out_frac']:.4f} "
                  f"(required <= {TACTICIAN_RADIAL_OUT_MAX:.2f}, over {row['threat_move_tiles']} threatened tiles)")
            judge(row["replans_per_s"] <= TACTICIAN_REPLANS_MAX,
                  f"{name} [{rule}]: replans_per_s {row['replans_per_s']:.3f} (required <= {TACTICIAN_REPLANS_MAX:g})")
            judge(row["heading_reversals_per_s"] <= TACTICIAN_REVERSALS_MAX,
                  f"{name} [{rule}]: heading_reversals_per_s {row['heading_reversals_per_s']:.2f} "
                  f"(required <= {TACTICIAN_REVERSALS_MAX:g})")
    for row in rows:   # a locked scenario the list above does not know is a boss scenario too
        if row.get("lock") and row["scenario"] not in BOSS_SCENARIOS:
            failed.append(f"{row['scenario']} [{row['rule']}]: runs with a lock but is not in BOSS_SCENARIOS")
    return passed, failed

# Decision telemetry (UDodgeTelemetry.h). Every [Diag/Nav] decision line carries these keys.
TELEMETRY_KEYS = ["t", "why", "mode", "rule", "nav", "corridor", "map_pending", "assist", "obj", "target", "at",
                  "dist", "bearing", "ring", "player", "goal", "navroute", "wpts", "partial", "ring_approach", "plan", "solve",
                  "src", "drive", "clr", "cmd", "radial", "tang", "replan", "reversal", "lanes", "zones",
                  "enemies", "worker_ms", "timed", "reused", "budget_hit", "dropped"]
TELEMETRY_MAX_LINES_PER_S = 8 + 3 + 1 + 1   # the three change classes' ceilings plus the heartbeat
ROW_TIMING_FIELDS = {"tick_ms_avg", "tick_ms_max", "nav_ms_avg", "nav_ms_max", "dodge_ms_avg", "dodge_ms_max",
                     "cycle_ms_avg", "cycle_ms_max", "dodge_ms_p95", "cycle_ms_p95"}


def telemetry_check(binary, scan):
    """Run the production Tick with diagnostics off and on. Returns a list of failures."""
    failures = []

    def run(name, rule, navigator, diag):
        env = {k: v for k, v in os.environ.items() if k != "HARNESS_DIAG"}
        env["HARNESS_NAVIGATOR"] = navigator
        if diag:
            env["HARNESS_DIAG"] = "1"
        done = subprocess.run([str(binary), name, str(scan), rule], check=True, env=env,
                              capture_output=True, text=True)
        row = json.loads(done.stdout.strip().splitlines()[-1])
        return row, done.stderr

    def judge(ok, text):
        print(("ok    " if ok else "FAIL  ") + text)
        if not ok:
            failures.append(text)

    for name, rule, navigator in (("d_boss_open_dense", "game", "legacy"), ("d_boss_open_rings", "legacy", "legacy"),
                                  ("o_pending_map_waypoint", "game", "dstar")):
        label = f"{name} [{rule}, {navigator}]"
        off_row, off_err = run(name, rule, navigator, False)
        on_row, on_err = run(name, rule, navigator, True)
        judge(off_err == "" and off_row["diag_lines"] == 0,
              f"{label}: diagnostics off writes nothing ({off_row['diag_lines']} log calls, {len(off_err)} bytes)")
        judge(on_row["diag_lines"] > 0, f"{label}: diagnostics on writes ({on_row['diag_lines']} log calls)")
        same = all(off_row[k] == on_row[k] for k in off_row if k not in ROW_TIMING_FIELDS | {"diag_lines"})
        judge(same, f"{label}: the run is identical with diagnostics on (telemetry only observes)")
        lines = [line for line in on_err.splitlines() if line.startswith("[Diag/Nav] ")]
        sim_s = on_row["sim_s"]
        judge(len(lines) > 0 and " why=first " in lines[0], f"{label}: {len(lines)} decision lines, the first says why=first")
        missing = sorted({key for line in lines for key in TELEMETRY_KEYS if not re.search(rf"[ (]{key}=", line)})
        judge(not missing, f"{label}: every line carries every field (missing: {missing or 'none'})")
        judge(len(lines) <= TELEMETRY_MAX_LINES_PER_S * max(sim_s, 1.0),
              f"{label}: {len(lines) / max(sim_s, 1e-9):.1f} lines per scenario second (ceiling {TELEMETRY_MAX_LINES_PER_S})")
        beats = sum(" why=heartbeat" in line or ",heartbeat " in line for line in lines)
        judge(0.8 * sim_s - 1 <= beats <= sim_s + 1, f"{label}: {beats} heartbeats in {sim_s:.0f} s with an objective active")
        if name.startswith("d_boss"):
            judge(all(" mode=unified " in line and f" rule={rule} " in line and " nav=legacy " in line for line in lines),
                  f"{label}: mode, collision rule and navigator are reported")
            judge(any(" obj=lock_approach target=901 " in line and " ring=[" in line for line in lines),
                  f"{label}: the lock approach names its target and engagement ring")
            judge(any(" win{frames=" in line for line in lines), f"{label}: heartbeats carry the window totals")
        else:
            walking = [line for line in lines if " obj=walk_to " in line]
            judge(bool(walking) and all(" nav=dstar " in line and " map_pending=1 " in line for line in walking),
                  f"{label}: the capture is pending all scenario long, and every walk-to line says nav=dstar map_pending=1")
            judge(" obj=none " in lines[-1] and "objective" in lines[-1],
                  f"{label}: arriving is an objective change to none")
    return failures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--internal", default=str(HERE.parents[1]))
    ap.add_argument("--label", default="tree")
    ap.add_argument("--only", default="")
    ap.add_argument("--binary-out", default="", help="also copy the built harness here")
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if any scenario outside KNOWN_LIMITATIONS fails")
    ap.add_argument("--metrics", action="store_true", help="print scenario measurements alongside check results")
    ap.add_argument("--table", action="store_true",
                    help="print one markdown table of every scenario under every rule run "
                         "(known limitations included) instead of the JSON rows")
    ap.add_argument("--tactician-acceptance", action="store_true",
                    help="run the boss scenarios and exit non-zero unless they meet the Tactician spec's "
                         "thresholds. Separate from --check; expected to fail until the Tactician lands")
    ap.add_argument("--telemetry-check", action="store_true",
                    help="run the production Tick with field diagnostics off and on and check the "
                         "[Diag/Nav] decision lines (off is silent, on only observes)")
    ap.add_argument("--stage2-regressions", action="store_true",
                    help="run unresolved persistent-routing regressions instead of the normal suite")
    ap.add_argument("--rule", choices=["legacy", "game", "both"], default="both",
                    help="navCollisionRule to run under (a tree without nav/Collision.h runs legacy only)")
    ap.add_argument("--navigator", choices=["legacy", "dstar"], default="legacy")
    ap.add_argument("--policy", choices=["tactician", "classic"], default="classic",
                    help="udodgePlanner the harness runs under. Default classic, so every existing "
                         "assertion and every recorded table keeps measuring the engine it measured before")
    ap.add_argument("--scan-mode", type=int, default=0,
                    help="tile list selection: 1 first 65536, 2 newest 65536 + window, 3 whole list windowed; 0 = detect")
    args = ap.parse_args()
    if args.tactician_acceptance and (args.check or args.only or args.stage2_regressions):
        ap.error("--tactician-acceptance is its own entry point: not with --check, --only or --stage2-regressions")
    if args.telemetry_check and (args.check or args.only or args.stage2_regressions or args.tactician_acceptance
                                 or args.table):
        ap.error("--telemetry-check is its own entry point")
    scenarios = STAGE2_REGRESSIONS if args.stage2_regressions else SCENARIOS
    if args.tactician_acceptance:
        scenarios = [name for name in SCENARIOS if name in BOSS_SCENARIOS]
    if args.only and args.only not in scenarios:
        ap.error("--only must name a scenario in the selected suite")
    internal = Path(args.internal).resolve()
    src = internal / "src"
    ud = src / "features/movement/udodge"
    st = src / "features/movement/spacetime"
    world_tab = (src / "gui/tabs/WorldTAB.cpp").read_text(errors="replace")
    if args.scan_mode:
        scan = args.scan_mode
    elif "SquareCoordCache" in world_tab:
        scan = 3
    elif "const int32_t first = listSize - cap" in world_tab:
        scan = 2
    else:
        scan = 1
    defines = []
    hazards = (ud / "UDodgeEnemyHazards.h").read_text()
    if "ObserveBlast" in hazards:
        defines.append("-DHARNESS_TREE_POST70=1")
    if "BurstKeepoutRadius" in hazards:
        defines.append("-DHARNESS_TREE_BURST=1")
    with tempfile.TemporaryDirectory(prefix="udodge-scenarios-") as tmp:
        tmp = Path(tmp)
        stubs = tmp / "stubs"
        shutil.copytree(HERE / "stubs", stubs)
        diag = src / "core/logging/DiagTiming.h"
        if diag.exists():
            shutil.copy(diag, stubs / "DiagTiming.h")
        binary = tmp / "harness"
        cmd = [os.environ.get("CXX", "c++"), "-std=c++17", "-O2", "-pthread", "-w",
               "-I", str(stubs), "-I", str(src), "-I", str(ud), "-I", str(st), *defines,
               *os.environ.get("HARNESS_CXXFLAGS", "").split(),
               str(ud / "UDodge.cpp"), str(ud / "UDodgeCore.cpp"), str(ud / "UDodgeSolver.cpp"),
               str(ud / "UDodgePathfinder.cpp"), str(st / "SpacetimeCore.cpp"),
               str(src / "features/movement/sensors/TileSensor.cpp"),
               str(HERE / "udodge_scenario_harness.cpp"), "-o", str(binary)]
        subprocess.run(cmd, check=True)
        if args.binary_out:
            shutil.copy(binary, args.binary_out)
        if args.telemetry_check:
            failures = telemetry_check(binary, scan)
            if failures:
                print(f"Decision telemetry check FAILED: {len(failures)} failures")
                sys.exit(1)
            print("Decision telemetry check passed")
            return
        has_rule = (src / "features/movement/nav/Collision.h").exists()
        rules = ["legacy", "game"] if args.rule == "both" else [args.rule]
        if not has_rule:
            rules = ["legacy"]
        failed = []
        rows = []
        for rule in rules:
            known = KNOWN_LIMITATIONS[rule]
            for name in scenarios:
                if args.only and name != args.only:
                    continue
                out = subprocess.run([str(binary), name, str(scan), rule, args.policy], check=True,
                                     env={**os.environ, "HARNESS_NAVIGATOR": args.navigator},
                                     capture_output=True, text=True).stdout.strip()
                if not out:
                    failed.append(f"{name} [{rule}] (no result)")   # a listed scenario the harness does not run
                for line in out.splitlines():
                    row = json.loads(line)
                    row["tree"] = args.label
                    row["scan_mode"] = scan
                    row["rule"] = rule
                    row["policy"] = args.policy
                    rows.append(row)
                    if args.metrics or not (args.check or args.table or args.tactician_acceptance):
                        print(json.dumps(row), flush=True)
                    if not row["success"] and name not in known:
                        failed.append(f"{name} [{rule}]")
                    # The game's MoveTo does not clamp distance: a step longer than the
                    # game's own speed allows is what the server sees, in every scenario.
                    elif row.get("overspeed_moves", 0) > 0:
                        failed.append(f"{name} [{rule}] (overspeed)")
                    # Under the game rule the worker plans over a copy of the squares the
                    # live check reads; any difference is a copy bug, in every scenario.
                    elif row.get("square_mismatches", 0) > 0:
                        failed.append(f"{name} [{rule}] (worker squares differ from the view)")
        if args.table:
            print(format_table(rows), flush=True)
        if args.tactician_acceptance:
            passed, unmet = tactician_acceptance(rows, rules)
            for line in passed:
                print("ok    " + line)
            for line in unmet:
                print("UNMET " + line)
            if unmet:
                print(f"Tactician acceptance FAILED: {len(unmet)} of {len(passed) + len(unmet)} thresholds unmet")
                sys.exit(1)
            print(f"Tactician acceptance passed ({len(passed)} thresholds)")
        if args.check:
            if failed:
                print("Pathing scenarios FAILED: " + ", ".join(failed))
                sys.exit(1)
            for rule in rules:
                known = KNOWN_LIMITATIONS[rule]
                print(f"Pathing scenarios passed under navCollisionRule={rule} "
                      f"({len(scenarios) - len(set(scenarios) & known)} asserted, "
                      f"{len(set(scenarios) & known)} known limitations reported only)")

if __name__ == "__main__":
    main()
