"""AUTONEXUS-SCAN-DIAG host checks; optional argv[1] writes a wire fixture for the bridge contract test."""
from pathlib import Path
import subprocess, tempfile, sys
root = Path(__file__).resolve().parents[1]
src = root / 'src'
bad = []
an = (src / 'features/combat/autonexus/AutoNexus.cpp').read_text()
if 'namespace S = AutoNexusScanCapture' not in an or 'CaptureScan(threats' not in an: bad.append('AutoNexus.cpp does not feed the scan capture')
if 'UDodgeCapture::capture.enabled' not in an: bad.append('scan capture is not gated on the encounter-capture flag')
if 'EncodeScan' not in (src / 'core/ipc/IpcBridge.cpp').read_text(): bad.append('IpcBridge does not drain scans')
for m in bad: print('FAIL source:', m)
with tempfile.TemporaryDirectory(prefix='autonexus-scan-') as temp:
    b = Path(temp); (b / 'pch-il2cpp.h').write_text('')
    exe = b / 'autonexus_scan_capture_tests'
    r = subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pthread', '-I', str(b), '-I', str(src),
                        '-I', str(src / 'features/movement/udodge'),
                        str(root / 'tests/autonexus_scan_capture_tests.cpp'), '-o', str(exe)])
    if r.returncode or subprocess.run([str(exe)] + sys.argv[1:2]).returncode: bad.append('host tests')
sys.exit(1 if bad else 0)
