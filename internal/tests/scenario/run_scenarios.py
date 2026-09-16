"""Build the UDodge scenario harness against one source tree and run every scenario.

    python3 run_scenarios.py --internal /path/to/internal [--label NAME] [--only SCENARIO]

The harness file and stubs always come from THIS checkout; the dodge sources come
from --internal, so the same scenarios can be run against an older tree. Each
scenario runs in its own process. Prints one JSON object per scenario.
"""
from pathlib import Path
import argparse, json, os, shutil, subprocess, sys, tempfile

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
KNOWN_LIMITATIONS = {
    "legacy": {"d_boss_open_dense", "d_boss_wall_dense", "m_pinch_nowalk", "m_pinch_object"},
    "game":   {"d_boss_open_dense", "d_boss_wall_dense"},
}

SCENARIOS = [
    "a_lake_deep_speed", "a_lake_deep_plain", "a_lake_shallow", "a_river_deep_speed", "a_river_shallow",
    "b_tree_cluster", "b_tree_cluster2",
    "c_u_wall", "c_u_wall_lock",
    "d_boss_open_rings", "d_boss_wall_rings", "d_boss_open_dense", "d_boss_wall_dense",
    "e_corridor1_nowalk", "e_corridor1_fullocc", "e_corridor2_fullocc",
    "f_damaging_row", "f_lava_detour", "f_lava_pressure", "g_fullocc_gap", "h_learned_keepout", "j_hidden_blocker",
    "i_tilelist_revisit", "i_tilelist_frontier",
    "k_slowed_midwalk", "k_paralyzed_midwalk", "k_water_midpath", "k_dodge_in_water",
    "k_speedy_walk", "k_slowed_water", "k_mixed_water_land",
    "l_walk_past_shotgun", "l_walk_past_bomber", "l_lock_boss_dies", "l_lock_boss_invuln",
    "m_pinch_nowalk", "m_pinch_fulloccupy", "m_pinch_object",
    "z_moveto_no_clamp",
    "n_rooms1_nowalk_forward", "n_rooms1_nowalk_reverse",
    "n_rooms2_nowalk_forward", "n_rooms2_nowalk_reverse",
    "n_rooms1_fullocc_forward", "n_rooms1_fullocc_reverse",
    "n_rooms2_fullocc_forward", "n_rooms2_fullocc_reverse",
    "n_rooms_reveal_forward", "n_rooms_reveal_reverse",
    "o_pending_map_waypoint", "o_pending_map_blocked",
]

STAGE2_REGRESSIONS = ["n_rooms_remote_forward", "n_rooms_remote_reverse"]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--internal", default=str(HERE.parents[1]))
    ap.add_argument("--label", default="tree")
    ap.add_argument("--only", default="")
    ap.add_argument("--binary-out", default="", help="also copy the built harness here")
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if any scenario outside KNOWN_LIMITATIONS fails")
    ap.add_argument("--metrics", action="store_true", help="print scenario measurements alongside check results")
    ap.add_argument("--stage2-regressions", action="store_true",
                    help="run unresolved persistent-routing regressions instead of the normal suite")
    ap.add_argument("--rule", choices=["legacy", "game", "both"], default="both",
                    help="navCollisionRule to run under (a tree without nav/Collision.h runs legacy only)")
    ap.add_argument("--navigator", choices=["legacy", "dstar"], default="legacy")
    ap.add_argument("--scan-mode", type=int, default=0,
                    help="tile list selection: 1 first 65536, 2 newest 65536 + window, 3 whole list windowed; 0 = detect")
    args = ap.parse_args()
    scenarios = STAGE2_REGRESSIONS if args.stage2_regressions else SCENARIOS
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
        has_rule = (src / "features/movement/nav/Collision.h").exists()
        rules = ["legacy", "game"] if args.rule == "both" else [args.rule]
        if not has_rule:
            rules = ["legacy"]
        failed = []
        for rule in rules:
            known = KNOWN_LIMITATIONS[rule]
            for name in scenarios:
                if args.only and name != args.only:
                    continue
                out = subprocess.run([str(binary), name, str(scan), rule], check=True,
                                     env={**os.environ, "HARNESS_NAVIGATOR": args.navigator},
                                     capture_output=True, text=True).stdout.strip()
                if not out:
                    failed.append(f"{name} [{rule}] (no result)")   # a listed scenario the harness does not run
                for line in out.splitlines():
                    row = json.loads(line)
                    row["tree"] = args.label
                    row["scan_mode"] = scan
                    row["rule"] = rule
                    if not args.check or args.metrics:
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
