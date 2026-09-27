"""AutoNexus native threat identity checks (host build, no game headers)."""
from pathlib import Path
import subprocess, tempfile, sys
root = Path(__file__).resolve().parents[1]
source = (root / 'src/features/combat/autonexus/AutoNexus.cpp').read_text()
# The producer must publish the identity helper's ids, never the spawn clock.
if 'AutoNexusThreatIdentity::FromStoreFields' not in source or 'th.bulletId      = proj.bulletId' in source:
    print('FAIL AutoNexus.cpp does not publish threats through AutoNexusThreatIdentity')
    sys.exit(1)
with tempfile.TemporaryDirectory(prefix='autonexus-identity-') as temp:
    b = Path(temp)
    exe = b / 'autonexus_threat_identity_tests'
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', str(root / 'src'),
                    str(root / 'tests/autonexus_threat_identity_tests.cpp'), '-o', str(exe)], check=True)
    subprocess.run([str(exe)], check=True)
