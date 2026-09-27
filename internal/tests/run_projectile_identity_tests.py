"""Spawn identity, provisional supersession, AutoNexus threat rows and scan tracks (host build)."""
from pathlib import Path
import subprocess, tempfile, sys
root = Path(__file__).resolve().parents[1]
src = root / 'src'
checks = [
    (src / 'features/movement/dodge/ProjectileTracking.cpp', 'ProjectileSpawnIdentity::FromSpawnArgs', 'spawn hook stores the corrected identity'),
    (src / 'features/movement/udodge/UDodgeSensors.cpp', 'ProjectileSpawnIdentity::IsSameShot', 'RuntimeHasShot supersedes by owner and bullet id'),
    (src / 'features/combat/autonexus/AutoNexus.cpp', 'AutoNexusThreatIdentity::DedupeThreats', 'AutoNexus publishes one row per bullet'),
    (src / 'features/combat/autonexus/AutoNexus.cpp', 'AutoNexusDodgePolicy::ProjectileTracks', 'AutoNexus scans projectiles on the local track'),
]
bad = [m for p, needle, m in checks if needle not in p.read_text()]
for m in bad: print('FAIL source:', m)
with tempfile.TemporaryDirectory(prefix='projectile-identity-') as temp:
    b = Path(temp)
    for name in ('projectile_spawn_identity_tests', 'autonexus_tracks_tests', 'autonexus_threat_identity_tests'):
        exe = b / name
        r = subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', str(src),
                            str(root / 'tests' / f'{name}.cpp'), '-o', str(exe)])
        if r.returncode or subprocess.run([str(exe)]).returncode: bad.append(name)
sys.exit(1 if bad else 0)
