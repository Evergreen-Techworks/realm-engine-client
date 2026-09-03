#!/usr/bin/env bash
# Host test loop for the Windows-free splash logic. Runs under WSL with g++;
# no game, no MSVC, no IL2CPP required. See docs/plans/110.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .testbuild
g++ -std=c++17 -Wall -Wextra -Werror -O0 -g \
    src/splash_logic.cpp tests/splash_logic_tests.cpp \
    -o .testbuild/splash_logic_tests
./.testbuild/splash_logic_tests
