"""Compile the production math core with an empty Windows PCH on a C++17 host."""
from pathlib import Path
import os
import subprocess
import tempfile

internal = Path(__file__).resolve().parents[1]
core = internal / "src/features/movement/udodge"
with tempfile.TemporaryDirectory(prefix="udodge-zone-tests-") as directory:
    build = Path(directory)
    (build / "pch-il2cpp.h").write_text("""// Host shim for pathfinder timing only.
#include <chrono>
struct LARGE_INTEGER { long long QuadPart; };
inline void QueryPerformanceFrequency(LARGE_INTEGER* p) { p->QuadPart = 1000000000; }
inline void QueryPerformanceCounter(LARGE_INTEGER* p) {
    p->QuadPart = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}
""")
    spacetime = internal / "src/features/movement/spacetime"
    for test in ("udodge_zone_tests", "udodge_temporal_tests", "udodge_admission_tests",
                 "udodge_speed_expiry_tests", "udodge_commitment_tests", "udodge_navigation_tests",
                 "udodge_timed_tests", "udodge_prune_tests", "udodge_pathing_rules_tests",
                 "udodge_worker_clock_tests", "udodge_telemetry_tests", "udodge_temporal_broadphase_tests"):
        binary = build / test
        extra = [str(core / "UDodgeWorker.cpp"), str(spacetime / "SpacetimeCore.cpp")] \
            if test == "udodge_commitment_tests" else []
        if test in ("udodge_navigation_tests", "udodge_pathing_rules_tests"):
            extra = [str(core / "UDodgePathfinder.cpp")]
        if test in ("udodge_timed_tests", "udodge_worker_clock_tests"):
            extra = [str(spacetime / "SpacetimeCore.cpp")]
        subprocess.run([
            os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-pthread",
            # 1.2 million differential queries against a plain all-lanes reference.
            *(["-O2"] if test == "udodge_temporal_broadphase_tests" else []),
            "-I", str(build), "-I", str(core), "-I", str(internal / "src"),
            str(core / "UDodgeCore.cpp"), str(core / "UDodgeSolver.cpp"),
            *extra, str(internal / f"tests/{test}.cpp"),
            "-o", str(binary),
        ], check=True)
        subprocess.run([str(binary)], check=True)

# Navigation rebuild Stage 1 foundation: the game's collision rule and the speed model.
for test in ("nav_collision_tests", "nav_speed_tests", "nav_map_memory_tests", "nav_router_tests"):
    with tempfile.TemporaryDirectory(prefix=test + "-") as directory:
        binary = Path(directory) / test
        subprocess.run([
            os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-pthread",
            *(["-O2"] if test == "nav_router_tests" else []),
            "-I", str(internal / "src"), str(internal / f"tests/{test}.cpp"),
            "-o", str(binary),
        ], check=True)
        subprocess.run([str(binary)], check=True)

with tempfile.TemporaryDirectory(prefix="nav-runtime-tests-") as directory:
    binary = Path(directory) / "nav_runtime_tests"
    subprocess.run([
        os.environ.get("CXX", "c++"), "-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror", "-pthread",
        "-DNAV_RUNTIME_TEST_TIMING", "-I", str(internal / "tests/nav_runtime_shim"), "-I", str(internal / "src"),
        str(internal / "tests/nav_runtime_tests.cpp"), str(internal / "src/features/movement/nav/Runtime.cpp"),
        "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)

# Enemy snapshot rules, the render/game-thread snapshot hand-off and the lock policy.
with tempfile.TemporaryDirectory(prefix="enemy-tracker-tests-") as directory:
    binary = Path(directory) / "enemy_tracker_tests"
    subprocess.run([
        os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-pthread",
        "-I", str(internal / "src"), str(internal / "tests/enemy_tracker_tests.cpp"),
        "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)

# Native AutoFire trigger rules: script-armed firing only at a real Auto Aim target.
with tempfile.TemporaryDirectory(prefix="autofire-decision-tests-") as directory:
    binary = Path(directory) / "autofire_decision_tests"
    subprocess.run([
        os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-pthread",
        "-I", str(internal / "src"), str(internal / "tests/autofire_decision_tests.cpp"),
        "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)

# End-to-end pathing scenarios against the production planner (tests/scenario).
subprocess.run(["python3", str(internal / "tests/scenario/run_scenarios.py"), "--check"], check=True)
# UDodge decision telemetry through the production Tick: off is silent, on only observes.
subprocess.run(["python3", str(internal / "tests/scenario/run_scenarios.py"), "--telemetry-check"], check=True)

# Native input focus gate, and SteerInput compiled on a fake Windows layer.
with tempfile.TemporaryDirectory(prefix="input-focus-tests-") as directory:
    binary = Path(directory) / "input_focus_tests"
    subprocess.run([
        os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-pthread",
        "-I", str(internal / "tests/input_focus_shim"), "-I", str(internal / "tests"),
        "-I", str(internal / "src"), "-I", str(internal / "src/features/movement/dodge"),
        str(internal / "tests/input_focus_tests.cpp"),
        str(internal / "src/features/movement/dodge/SteerInput.cpp"),
        "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)
