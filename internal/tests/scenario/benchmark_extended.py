"""Structural and stall benchmark. Exit 1 means candidate acceptance failed.

Run development layouts by default. A reserved JSON plan must be sealed before
tuning and consumed once; its digest is recorded. Never call a reused set held out.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from benchmark_navigation import environment, validate_metrics
from run_scenarios import BENCHMARK_SCENARIOS, BOSS_SCENARIOS, tactician_acceptance


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def safety_regressions(old,new):
    reasons=[]
    for key in ('deaths','escapes','hits','damaging_ground_frames','refused_moves','overspeed_moves',
                'damage_peak_100ms','damage_peak_250ms','damage_peak_500ms'):
        if new[key]>old[key]: reasons.append(key+' increased')
    if old['success'] and not new['success']: reasons.append('completion lost')
    if not old.get('lock') and new.get('final_dist',0) > old.get('final_dist',0)+.5:
        reasons.append('route progress lost')
    return reasons


def run(binary,name,rule,env):
    r=subprocess.run([str(binary),name,'3',rule,'tactician'],env=env,capture_output=True,text=True,check=True,timeout=120)
    row=json.loads(r.stdout.strip().splitlines()[-1]);validate_metrics(row,name)
    return row


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for k in ('baseline','candidate','output'):p.add_argument('--'+k,type=Path,required=True)
    p.add_argument('--plan',type=Path,help='reserved scenario seed/settings manifest')
    p.add_argument('--mutation-check',action='store_true')
    a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
    plan=json.loads(a.plan.read_text()) if a.plan else dict(seeds=[0],settings={})
    seeds=plan['seeds']
    if not seeds or any(not isinstance(s,int) for s in seeds):p.error('plan needs integer seeds')
    for binary in (a.baseline,a.candidate):
        subprocess.run([str(binary.resolve()),'--benchmark-selfcheck'],check=True,capture_output=True,text=True)
    rows=[];failures=[];mutations=[]
    for name in BENCHMARK_SCENARIOS:
        for rule in ('legacy','game'):
            for seed in seeds:
                for stall in (0,50,100,250,500):
                    case=dict(profile='live',navigator='legacy',speed='',start_shift='',settings=plan.get('settings',{}))
                    env=environment(case);env.update(HARNESS_LAYOUT_SEED=str(seed),HARNESS_STALL_MS=str(stall))
                    pair={k:run(getattr(a,k).resolve(),name,rule,env) for k in ('baseline','candidate')}
                    old,new=pair['baseline'],pair['candidate']
                    reasons=safety_regressions(old,new)
                    if new['deaths'] or new['escapes']:reasons.append('absolute survival/completion gate')
                    if not new['success']:reasons.append('scenario incomplete')
                    if new['events_fired']<2 or not new['shots_spawned']:raise ValueError('unexercised fixture')
                    if stall and new['sim_s']>1+stall/1000 and new['max_decision_age_ms'] < stall-20:
                        raise ValueError('requested controller stall did not execute')
                    row=dict(scenario=name,rule=rule,seed=seed,stall_ms=stall,settings=env_subset(env),**pair,reasons=reasons,
                             relative_regressions=safety_regressions(old,new))
                    rows.append(row)
                    if reasons:failures.append({k:row[k] for k in ('scenario','rule','seed','stall_ms','reasons')})
                    if a.mutation_check and stall==0:
                        broken=run(a.candidate.resolve(),name,rule,{**env,'HARNESS_DISABLE_CONTROLLER':'1'})
                        mutation_reasons=safety_regressions(new,broken)
                        caught=bool(mutation_reasons)
                        mutations.append(dict(scenario=name,rule=rule,seed=seed,caught=caught,
                                              reasons=mutation_reasons,metrics=broken))
                        if not caught:failures.append(dict(scenario=name,reason='controller mutation escaped detection'))
    # Mandatory Tactician acceptance, including known limitations. Do not hide
    # those failures behind the classic-policy host-suite result.
    tactician=[]
    env=environment(dict(profile='live',navigator='legacy',speed='',start_shift='',settings=plan.get('settings',{})))
    for rule in ('legacy','game'):
        for name in BOSS_SCENARIOS:
            row=run(a.candidate.resolve(),name,rule,env);row['rule']=rule
            tactician.append(row)
    _,acceptance=tactician_acceptance(tactician, ('legacy','game'))
    relative=[dict(scenario=r['scenario'],rule=r['rule'],stall_ms=r['stall_ms'],reasons=r['relative_regressions'])
              for r in rows if r['relative_regressions']]
    result=dict(policy='tactician',profile='live',rows=rows,regressions=relative,acceptance_failures=failures,mutations=mutations,
                tactician_acceptance=acceptance,plan=plan,plan_sha256=digest(a.plan) if a.plan else None,
                baseline_sha256=digest(a.baseline),candidate_sha256=digest(a.candidate),
                note='Synthetic health/escape and controller stalls; not live AutoNexus or FPS verification.')
    (a.output/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(dict(cases=len(rows),regressions=len(relative),acceptance_failures=len(failures),tactician_acceptance=acceptance),indent=2))
    return bool(failures or acceptance)


def env_subset(env):return {k:v for k,v in env.items() if k.startswith('HARNESS_')}


if __name__=='__main__':sys.exit(main())
