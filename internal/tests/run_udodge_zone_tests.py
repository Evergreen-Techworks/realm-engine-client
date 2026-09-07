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
    for test in ("udodge_zone_tests", "udodge_temporal_tests", "udodge_admission_tests",
                 "udodge_speed_expiry_tests", "udodge_commitment_tests", "udodge_navigation_tests"):
        binary = build / test
        extra = [str(core / "UDodgeWorker.cpp")] if test == "udodge_commitment_tests" else []
        if test == "udodge_navigation_tests":
            extra = [str(core / "UDodgePathfinder.cpp")]
        subprocess.run([
            os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-pthread",
            "-I", str(build), "-I", str(core),
            str(core / "UDodgeCore.cpp"), str(core / "UDodgeSolver.cpp"),
            *extra, str(internal / f"tests/{test}.cpp"),
            "-o", str(binary),
        ], check=True)
        subprocess.run([str(binary)], check=True)
