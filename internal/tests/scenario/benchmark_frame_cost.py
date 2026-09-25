"""Serial paired native timing; this does not measure live renderer FPS.

Use binaries from benchmark_navigation.py. Pins both revisions to the same CPU,
warms each case, alternates order, and reports medians of repeated per-run stats.
The harness executes worker work inline, so tick timing includes worker cost.
Do not run concurrently with other benchmark/build jobs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys

from benchmark_navigation import environment

SCENARIOS = ("c_u_wall", "n_rooms1_fullocc_forward",
             "d_boss_open_rings", "d_boss_open_dense", "d_boss_wall_dense",
             "p_walk_pack_late_crossfire", "f_lava_pressure")
METRICS = ("tick_ms_avg", "tick_ms_p95", "tick_ms_p99", "tick_ms_max", "dodge_ms_avg",
           "dodge_ms_p95", "cycle_ms_avg", "cycle_ms_p95")


def timing_status(hashes, flags):
    if hashes['baseline'] == hashes['candidate'] and flags:
        return 'inconclusive_environment_noise'
    return 'regression_flags' if flags else 'no_detected_regression'


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--baseline", type=Path, required=True)
    ap.add_argument("--candidate", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--repeats", type=int, default=7)
    ap.add_argument("--allow-movement-change", action="store_true",
                    help="allow A/B-validated route changes; still reject added hits or nondeterminism")
    args = ap.parse_args()
    if args.repeats < 3:
        ap.error("use at least three measured repetitions")
    args.output.mkdir(parents=True, exist_ok=False)
    cpu = min(os.sched_getaffinity(0))
    os.sched_setaffinity(0, {cpu})
    binaries = {k: getattr(args, k).resolve() for k in ("baseline", "candidate")}
    rows = []
    with (args.output / "raw.jsonl").open("w") as raw:
        for scenario in SCENARIOS:
            for rule in ("legacy", "game"):
                case = dict(profile="shipped", rule=rule, scenario=scenario,
                            navigator="dstar" if "remote" in scenario else "legacy",
                            speed="", start_shift="")
                env = environment(case)
                for repeat in range(-1, args.repeats):
                    order = ("baseline", "candidate") if repeat % 2 == 0 else ("candidate", "baseline")
                    for revision in order:
                        result = subprocess.run([str(binaries[revision]), scenario, "3", rule, "tactician"],
                                                env=env, capture_output=True, text=True, check=True)
                        metrics = json.loads(result.stdout.strip().splitlines()[-1])
                        if repeat < 0:
                            continue
                        row = dict(scenario=scenario, rule=rule, revision=revision,
                                   repeat=repeat, metrics=metrics)
                        rows.append(row)
                        raw.write(json.dumps(row) + "\n")
                        raw.flush()
    comparisons = []
    regressions = []
    for scenario in SCENARIOS:
        for rule in ("legacy", "game"):
            medians = {revision: {metric: statistics.median(
                r["metrics"][metric] for r in rows if r["scenario"] == scenario
                and r["rule"] == rule and r["revision"] == revision)
                for metric in METRICS} for revision in binaries}
            comparisons.append(dict(scenario=scenario, rule=rule, **medians))
            for metric in ("tick_ms_avg", "tick_ms_p95", "tick_ms_p99", "tick_ms_max"):
                old, new = medians["baseline"][metric], medians["candidate"][metric]
                if new > old + max(0.5 if metric == "tick_ms_max" else 0.05, old * 0.10):
                    regressions.append(dict(scenario=scenario, rule=rule, metric=metric,
                                            baseline=old, candidate=new))
            behavior = ("success", "hits", "path_tiles", "time_s", "final_dist", "refused_moves",
                        "overspeed_moves", "paused_travel_frames", "in_range_frames")
            groups = {revision: [r["metrics"] for r in rows if r["scenario"] == scenario
                                 and r["rule"] == rule and r["revision"] == revision]
                      for revision in binaries}
            for revision, samples in groups.items():
                if any(any(m[k] != samples[0][k] for k in behavior) for m in samples[1:]):
                    regressions.append(dict(scenario=scenario, rule=rule, revision=revision,
                                            reason="behavior varied across repetitions"))
            old, new = groups["baseline"][0], groups["candidate"][0]
            if not args.allow_movement_change and any(old[k] != new[k] for k in behavior):
                regressions.append(dict(scenario=scenario, rule=rule, reason="shipped behavior changed"))
            if (old["success"] and not new["success"]) or any(
                    new[k] > old[k] for k in ("hits", "refused_moves", "overspeed_moves")):
                regressions.append(dict(scenario=scenario, rule=rule, reason="safety regressed"))
    hashes = {k:hashlib.sha256(p.read_bytes()).hexdigest() for k,p in binaries.items()}
    status = timing_status(hashes, regressions)
    summary = dict(cpu=cpu, repeats=args.repeats, profile="shipped", comparison_status=status,
                   allow_movement_change=args.allow_movement_change,
                   binaries={k: {"path": str(p), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                             for k, p in binaries.items()},
                   note="Native simulation timing, worker executed inline; not live FPS.",
                   comparisons=comparisons, timing_flags=regressions,
                   regressions=[] if status == 'inconclusive_environment_noise' else regressions)
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return bool(regressions)


if __name__ == "__main__":
    sys.exit(main())
