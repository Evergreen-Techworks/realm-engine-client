import os,subprocess,tempfile,shutil,json
from pathlib import Path
repo=Path('/home/jesse/rec-worktrees/predictive-nexus-testlab')
here=repo/'internal/tests/scenario'
with tempfile.TemporaryDirectory(prefix='dodge-delay-sweep-') as td:
 t=Path(td);h=t/'harness.cpp'
 h.write_text((here/'udodge_scenario_harness.cpp').read_text().replace('true, 200.0);','true, std::atof(std::getenv("HARNESS_TEST_SHOT_DELAY")));'))
 stubs=t/'stubs';shutil.copytree(here/'stubs',stubs)
 shutil.copy(repo/'internal/src/core/logging/DiagTiming.h',stubs/'DiagTiming.h')
 for label,root in [('candidate35-fallbackoff',repo)]:
  src=root/'internal/src';ud=src/'features/movement/udodge';st=src/'features/movement/spacetime';binary=t/label
  cmd=['c++','-std=c++17','-O2','-pthread','-w','-I',str(stubs),'-I',str(src),'-I',str(ud),'-I',str(st),'-DHARNESS_TREE_POST70=1','-DHARNESS_TREE_BURST=1',*[str(ud/n) for n in ['UDodge.cpp','UDodgeCore.cpp','UDodgeSolver.cpp','UDodgePathfinder.cpp']],str(st/'SpacetimeCore.cpp'),str(src/'features/movement/sensors/TileSensor.cpp'),str(h),'-o',str(binary)]
  subprocess.run(cmd,check=True)
  for delay in (0,100,150,200,250,300):
   for rule in ('legacy','game'):
    mode='on' if label.startswith('candidate35') else 'off'
    env={**os.environ,'HARNESS_TEST_SHOT_DELAY':str(delay),'HARNESS_NAVIGATOR':'legacy','HARNESS_ROUTE_COMMIT':mode,'HARNESS_ENEMY_STANDOFF':mode,'HARNESS_FALLBACK_SIDESTEP':'off','HARNESS_FRAME_BUDGET':'off'}
    p=subprocess.run([str(binary),'p_walk_pack_late_crossfire','3',rule,'tactician'],env=env,capture_output=True,text=True,check=True)
    r=json.loads(p.stdout.strip().splitlines()[-1]);r.update(tree=label,delay_ms=delay,rule=rule);print(json.dumps(r),flush=True)
