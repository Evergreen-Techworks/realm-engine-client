"""Paired native navigation benchmark using one harness against two source trees.

Both production revisions are compiled with THIS checkout's harness. No game,
account, settings file or Windows build source is touched. Each case starts a fresh
process and uses simulated time; host CPU timings are retained but not scored.

python3 internal/tests/scenario/benchmark_navigation.py \
  --baseline-internal /path/to/pinned-base/internal --output /tmp/navigation-ab

--suite bullets runs 72 matched crossfire encounters with mirrored layouts,
three first-volley phases and three visibility delays. Acceptance requires an
actual hit reduction as well as the per-case safety and completion gates.
"""
from pathlib import Path
import argparse
import csv
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import math
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


def bullet_cases():
    """Vary shot visibility and encounter orientation without tuning production settings."""
    for profile in ('fixture', 'shipped'):
        for rule in ('legacy', 'game'):
            for delay in (0, 100, 200):
                for phase in (0, 150, 350):
                    for mirror in (False, True):
                        yield dict(profile=profile, rule=rule,
                                   scenario='p_walk_pack_late_crossfire', navigator='legacy',
                                   speed='', start_shift='', delay=delay, phase=phase, mirror=mirror)


def bullet_holdout_cases():
    """Historical stress regression set; repeatedly used in tuning, NOT a holdout."""
    for profile in ('fixture', 'shipped'):
        for rule in ('legacy', 'game'):
            for delay in (150, 250):
                for shot_speed in (6, 12):
                    for rotate in (False, True):
                        for mirror in (False, True):
                            yield dict(profile=profile, rule=rule,
                                       scenario='p_walk_pack_late_crossfire', navigator='legacy',
                                       speed='', start_shift='', delay=delay, phase=225, mirror=mirror,
                                       shot_speed=shot_speed, rotate=rotate)


def bullet_outcome_passed(metrics):
    """Actual damage and completion, independent of the optional standoff-band score."""
    return metrics['final_dist'] < 0.6 and all(metrics[k] == 0 for k in
        ('hits', 'stuck_s', 'refused_moves', 'overspeed_moves', 'damaging_ground_frames'))


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
    if case['profile'] == 'live':
        env.update(HARNESS_ROUTE_COMMIT='off', HARNESS_ENEMY_STANDOFF='auto')
    # Explicit captured settings override a named profile, never ambient env.
    allowed = {'HARNESS_ROUTE_COMMIT', 'HARNESS_ENEMY_STANDOFF', 'HARNESS_FALLBACK_SIDESTEP',
               'HARNESS_FRAME_BUDGET', 'HARNESS_NAVIGATOR', 'HARNESS_PLAYER_SPEED'}
    overrides = case.get('settings', {})
    if set(overrides)-allowed:
        raise ValueError('unsupported benchmark setting')
    env.update({k:str(v) for k,v in overrides.items()})
    if case['speed'] != '':
        env['HARNESS_ROOM_SPEED'] = str(case['speed'])
        env['HARNESS_ROOM_START_SHIFT'] = str(case['start_shift'])
    if 'delay' in case:
        env['HARNESS_PACK_DELAY_MS'] = str(case['delay'])
        env['HARNESS_PACK_PHASE_MS'] = str(case['phase'])
        if case['mirror']:
            env['HARNESS_PACK_MIRROR'] = '1'
    if 'shot_speed' in case:
        env['HARNESS_PACK_SHOT_SPEED'] = str(case['shot_speed'])
        if case['rotate']:
            env['HARNESS_PACK_ROTATE'] = '1'
    return env


def validate_metrics(metrics, scenario):
    if metrics.get('scenario') != scenario:
        raise ValueError('Harness emitted a different scenario')
    for key in METRICS:
        value = metrics.get(key)
        if not isinstance(value, (int,float)) or not math.isfinite(value):
            raise ValueError(f'missing/nonfinite metric: {key}')
    if metrics.get('benchmark_valid') is not True:
        raise ValueError('missing fixture validity evidence')


def build(internal, binary, output):
    with output.open('w') as log:
        subprocess.run([sys.executable, str(HERE / 'run_scenarios.py'),
                        '--internal', str(internal), '--policy', 'tactician',
                        '--only', 'z_moveto_no_clamp', '--rule', 'both', '--check',
                        '--binary-out', str(binary)], stdout=log,
                       stderr=subprocess.STDOUT, check=True)


def harness_digest():
    h = hashlib.sha256()
    for path in sorted(HERE.rglob('*')):
        if path.is_file() and path.suffix in ('.cpp','.h','.py'):
            h.update(str(path.relative_to(HERE)).encode()+b'\0'+path.read_bytes())
    return h.hexdigest()


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
        validate_metrics(metrics, case['scenario'])
        pair[revision] = metrics
    return index, case, pair


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--baseline-internal', required=True, type=Path)
    ap.add_argument('--candidate-internal', type=Path, default=HERE.parents[1])
    ap.add_argument('--output', required=True, type=Path)
    ap.add_argument('--jobs', type=int, choices=range(1, 5), default=4)
    ap.add_argument('--suite', choices=('navigation', 'bullets', 'bullets-holdout'), default='navigation')
    args = ap.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    metadata = {'baseline': provenance(args.baseline_internal.resolve()),
                'candidate': provenance(args.candidate_internal.resolve()),
                'harness_sha256': harness_digest(),
                'holdout_note': 'bullets-holdout is a reused regression set, not independent validation',
                'policy': 'tactician', 'scan_mode': 3, 'suite': args.suite}
    (out / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    binaries = {}
    for label, internal in [('baseline', args.baseline_internal), ('candidate', args.candidate_internal)]:
        binaries[label] = out / (label + '-harness')
        build(internal.resolve(), binaries[label], out / (label + '-build.log'))
    metadata['binaries'] = {k:hashlib.sha256(p.read_bytes()).hexdigest() for k,p in binaries.items()}
    (out / 'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
    rows = []
    regressions = []
    with (out / 'results.csv').open('w', newline='') as csvfile, (out / 'raw.jsonl').open('w') as raw, ThreadPoolExecutor(max_workers=args.jobs) as pool:
        writer = csv.DictWriter(csvfile, fieldnames=['case', 'profile', 'rule', 'scenario',
                               'navigator', 'speed', 'start_shift',
                               *(['delay', 'phase', 'mirror'] if args.suite != 'navigation' else []),
                               *(['shot_speed', 'rotate'] if args.suite == 'bullets-holdout' else []),
                               'revision', *METRICS], lineterminator='\n')
        writer.writeheader()
        selected_cases = (bullet_holdout_cases() if args.suite == 'bullets-holdout'
                          else bullet_cases() if args.suite == 'bullets' else cases())
        for index, case, pair in pool.map(lambda item: run_pair(item, binaries), enumerate(selected_cases)):
            for revision, metrics in pair.items():
                raw.write(json.dumps(dict(case=index, **case, revision=revision, metrics=metrics)) + '\n')
                row = dict(case=index, **case, revision=revision,
                           **{key: metrics[key] for key in METRICS})
                writer.writerow(row)
                rows.append(row)
            old, new = pair['baseline'], pair['candidate']
            reasons = []
            old_pass = old['success'] if args.suite == 'navigation' else bullet_outcome_passed(old)
            new_pass = new['success'] if args.suite == 'navigation' else bullet_outcome_passed(new)
            if old_pass and not new_pass:
                reasons.append('pass lost')
            if old['final_dist'] < 0.6 and new['final_dist'] >= 0.6:
                reasons.append('arrival lost')
            for metric in ('hits', 'overspeed_moves', 'refused_moves', 'damaging_ground_frames'):
                if new[metric] > old[metric]:
                    reasons.append(metric + ' increased')
            if new['stuck_s'] > old['stuck_s']:
                reasons.append('stuck time increased')
            completed = old['success'] or (args.suite != 'navigation' and old['final_dist'] < 0.6)
            if completed and new['time_s'] > old['time_s'] + max(0.25, old['time_s'] * 0.05):
                reasons.append('arrival slower by >5% and >0.25s')
            if old['lock'] and new['in_range_frac'] < old['in_range_frac'] - 0.02:
                reasons.append('boss engagement fraction decreased by >0.02')
            if reasons:
                regressions.append(dict(case=index, **case, reasons=reasons))
            csvfile.flush()
            raw.flush()
    if args.suite == 'navigation':
        regressions.extend(remote_travel_acceptance(rows))
    summary = {'cases_per_revision': len(rows) // 2, 'regressions': regressions}
    for revision in binaries:
        subset = [r for r in rows if r['revision'] == revision]
        summary[revision] = {'passed': sum(r['success'] for r in subset),
                             'hits': sum(r['hits'] for r in subset)}
        if args.suite != 'navigation':
            summary[revision].update(
                proximity_passed=summary[revision]['passed'],
                passed=sum(bullet_outcome_passed(r) for r in subset),
                completed=sum(r['final_dist'] < 0.6 for r in subset),
                hit_free_completions=sum(r['final_dist'] < 0.6 and r['hits'] == 0 for r in subset),
                worst_case_hits=max(r['hits'] for r in subset))
    if args.suite != 'navigation' and summary['baseline']['hits'] > 0:
        if summary['candidate']['hits'] >= summary['baseline']['hits']:
            regressions.append(dict(reasons=['no reduction in projectile hits']))
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))
    return bool(regressions)


if __name__ == '__main__':
    sys.exit(main())
