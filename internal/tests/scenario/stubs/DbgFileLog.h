#pragma once
// Harness stand-in: trace sites compile to nothing; the ungated raw writer (field
// diagnostics) goes to stderr when HARNESS_DIAG is set.
#include "harness_win.h"
#define DBG_FILE_LOG(expr) ((void)0)
inline const char* DbgFileLogPath() { return ""; }
inline void DbgFileLogWrite(const char* msg)
{
    if (std::getenv("HARNESS_DIAG") && msg) std::fprintf(stderr, "%s\n", msg);
}
