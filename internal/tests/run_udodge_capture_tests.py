"""Bounded capture and production-solver parity checks; optional wire JSON output."""
from pathlib import Path
import subprocess, tempfile, sys
root=Path(__file__).resolve().parents[1]
core=root/'src/features/movement/udodge'
with tempfile.TemporaryDirectory(prefix='capture-tests-') as temp:
 b=Path(temp);(b/'pch-il2cpp.h').write_text('')
 for name,solver in [('udodge_capture_tests',False),('udodge_capture_solver_tests',True),('udodge_admission_tests',True),('udodge_capture_wire_fixture',False)]:
  cmd=['c++','-std=c++17','-Wall','-Wextra','-Werror','-pthread','-I',str(b),'-I',str(root/'src'),'-I',str(core)]
  if solver:cmd += [str(core/'UDodgeCore.cpp'),str(core/'UDodgeSolver.cpp')]
  cmd += [str(root/'tests'/f'{name}.cpp'),'-o',str(b/name)]
  subprocess.run(cmd,check=True)
  if name.endswith('wire_fixture'):
   data=subprocess.check_output([str(b/name)],text=True)
   if len(sys.argv)>1:Path(sys.argv[1]).write_text(data)
  else:subprocess.run([str(b/name)],check=True)
