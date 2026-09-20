from pathlib import Path
import argparse
import os
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--document-current-limitation", action="store_true")
    args = parser.parse_args()
    internal = Path(__file__).resolve().parents[1]
    core = internal / "src/features/movement/udodge"
    with tempfile.TemporaryDirectory(prefix="nav-global-route-") as directory:
        build = Path(directory)
        (build / "pch-il2cpp.h").write_text("""
#include <chrono>
struct LARGE_INTEGER { long long QuadPart; };
inline void QueryPerformanceFrequency(LARGE_INTEGER* value) { value->QuadPart = 1000000000; }
inline void QueryPerformanceCounter(LARGE_INTEGER* value) {
    value->QuadPart = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}
""")
        binary = build / "nav_global_route_reproducer"
        subprocess.run([
            os.environ.get("CXX", "c++"), "-std=c++17", "-O2", "-Wall", "-Wextra", "-pthread",
            "-I", str(build), "-I", str(core), "-I", str(internal / "src"),
            str(core / "UDodgeCore.cpp"), str(core / "UDodgeSolver.cpp"),
            str(core / "UDodgePathfinder.cpp"),
            str(internal / "tests/nav_global_route_reproducer.cpp"), "-o", str(binary),
        ], check=True)
        command = [str(binary)]
        if args.document_current_limitation:
            command.append("--document-current-limitation")
        return subprocess.run(command).returncode


if __name__ == "__main__":
    raise SystemExit(main())
