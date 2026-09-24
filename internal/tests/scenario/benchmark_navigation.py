"""Paired native navigation benchmark using one harness against two source trees.

Both production revisions are compiled with THIS checkout's harness. No game,
account, settings file or Windows build source is touched. Each case starts a fresh
process and uses simulated time; host CPU timings are retained but not scored.

python3 internal/tests/scenario/benchmark_navigation.py \
  --baseline-internal /path/to/pinned-base/internal --output /tmp/navigation-ab
"""
from pathlib import Path
import argparse
import csv
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import subprocess
import sys

from run_scenarios import SCENARIOS

HERE = Path(__file__).resolve().parent
METRICS = ('success', 'time_s', 'final_dist', 'path_tiles', 'hits', 'stuck_s',
           'paused_travel_frames', 'refused_moves', 'overspeed_moves',
           'damaging_ground_frames', 'replans_nav_route', 'heading_reversals_per_s',
           'in_range_frac', 'radial_out_frac')


def cases():
    for profile in ('fixture', 'shipped'):
        for rule in ('legacy', 'game'):
            for scenario in SCENARIOS:
                yield dict(profile=profile, rule=rule, scenario=scenario,
                           navigator='legacy', speed='', start_shift='')
            for direction in ('forward', 'reverse'):
                for speed in (4, 6, 9):
                    for shift in (-0.2, 0, 0.2):
                        yield dict(profile=profile, rule=rule,
                                   scenario='n_rooms1_fullocc_' + direction,
                                   navigator='legacy', speed=speed, start_shift=shift)
                yield dict(profile=profile, rule=rule,
                           scenario='n_rooms_remote_' + direction,
                           navigator='dstar', speed='', start_shift='')


def remote_travel_acceptance(rows, revision="candidate"):
    """Quiet long-distance travel gets the same one-second pause limit under both rules."""
    remote = [r for r in rows if r["revision"] == revision
              and r["scenario"].startswith("n_rooms_remote_")]
    failures = []
    if len(remote) != 8:
        failures.append(dict(reasons=[f"expected 8 remote route rows, found {len(remote)}"]))
    for row in remote:
        if row["paused_travel_frames"] > 60:
            failures.append(dict(case=row["case"], profile=row["profile"], rule=row["rule"],
                                 scenario=row["scenario"],
                                 reasons=["quiet remote route paused for more than one second"]))
    return failures


def environment(case):
    env = {k: v for k, v in os.environ.items() if not k.startswith('HARNESS_')}
    toggle = 'on' if case['profile'] == 'fixture' else 'off'
    env.update(HARNESS_ROUTE_COMMIT=toggle, HARNESS_ENEMY_STANDOFF=toggle,
               HARNESS_FALLBACK_SIDESTEP='off', HARNESS_FRAME_BUDGET='off',
               HARNESS_NAVIGATOR=case['navigator'])
    if case['speed'] != '':
        env['HARNESS_ROOM_SPEED'] = str(case['speed'])
        env['HARNESS_ROOM_START_SHIFT'] = str(case['start_shift'])
    return env


def build(internal, binary, output):
    with output.open('w') as log:
        subprocess.run([sys.executable, str(HERE / 'run_scenarios.py'),
                        '--internal', str(internal), '--policy', 'tactician',
                        '--only', 'z_moveto_no_clamp', '--rule', 'both', '--check',
                        '--binary-out', str(binary)], stdout=log,
                       stderr=subprocess.STDOUT, check=True)


def provenance(internal):
    root = internal.parent
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    return {'root': str(root), 'head': git('rev-parse', 'HEAD'),
            'dirty': git('status', '--short'),
            'production_diff_sha256': hashlib.sha256(subprocess.check_output(
                ['git', '-C', str(root), 'diff', 'HEAD', '--', 'internal/src'])).hexdigest()}


def run_pair(item, binaries):
    index, case = item
    pair = {}
    for revision, binary in binaries.items():
        result = subprocess.run([str(binary), case['scenario'], '3', case['rule'], 'tactician'],
                                env=environment(case), capture_output=True, text=True,
                                check=True, timeout=300)
        metrics = json.loads(result.stdout.strip().splitlines()[-1])
        if metrics['scenario'] != case['scenario']:
            raise RuntimeError('Harness emitted a different scenario')
        pair[revision] = metrics
    return index, case, pair


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--baseline-internal', required=True, type=Path)
    ap.add_argument('--candidate-internal', type=Path, default=HERE.parents[1])
    ap.add_argument('--output', required=True, type=Path)
    ap.add_argument('--jobs', type=int, choices=range(1, 5), default=4)
    args = ap.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    metadata = {'baseline': provenance(args.baseline_internal.resolve()),
                'candidate': provenance(args.candidate_internal.resolve()),
                'harness_sha256': hashlib.sha256((HERE / 'udodge_scenario_harness.cpp').read_bytes()).hexdigest(),
                'policy': 'tactician', 'scan_mode': 3}
    (out / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    binaries = {}
    for label, internal in [('baseline', args.baseline_internal), ('candidate', args.candidate_internal)]:
        binaries[label] = out / (label + '-harness')
        build(internal.resolve(), binaries[label], out / (label + '-build.log'))
    rows = []
    regressions = []
    with (out / 'results.csv').open('w', newline='') as csvfile, (out / 'raw.jsonl').open('w') as raw, ThreadPoolExecutor(max_workers=args.jobs) as pool:
        writer = csv.DictWriter(csvfile, fieldnames=['case', 'profile', 'rule', 'scenario',
                               'navigator', 'speed', 'start_shift', 'revision', *METRICS], lineterminator='\n')
        writer.writeheader()
        for index, case, pair in pool.map(lambda item: run_pair(item, binaries), enumerate(cases())):
            for revision, metrics in pair.items():
                raw.write(json.dumps(dict(case=index, **case, revision=revision, metrics=metrics)) + '\n')
                row = dict(case=index, **case, revision=revision,
                           **{key: metrics[key] for key in METRICS})
                writer.writerow(row)
                rows.append(row)
            old, new = pair['baseline'], pair['candidate']
            reasons = []
            if old['success'] and not new['success']:
                reasons.append('pass lost')
            if old['final_dist'] < 0.6 and new['final_dist'] >= 0.6:
                reasons.append('arrival lost')
            for metric in ('hits', 'overspeed_moves', 'refused_moves', 'damaging_ground_frames'):
                if new[metric] > old[metric]:
                    reasons.append(metric + ' increased')
            if new['stuck_s'] > old['stuck_s']:
                reasons.append('stuck time increased')
            if old['success'] and new['time_s'] > old['time_s'] + max(0.25, old['time_s'] * 0.05):
                reasons.append('arrival slower by >5% and >0.25s')
            if old['lock'] and new['in_range_frac'] < old['in_range_frac'] - 0.02:
                reasons.append('boss engagement fraction decreased by >0.02')
            if reasons:
                regressions.append(dict(case=index, **case, reasons=reasons))
            csvfile.flush()
            raw.flush()
    regressions.extend(remote_travel_acceptance(rows))
    summary = {'cases_per_revision': len(rows) // 2, 'regressions': regressions}
    for revision in binaries:
        subset = [r for r in rows if r['revision'] == revision]
        summary[revision] = {'passed': sum(r['success'] for r in subset),
                             'hits': sum(r['hits'] for r in subset)}
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))
    return bool(regressions)


if __name__ == '__main__':
    sys.exit(main())
