#pragma once
// Harness stand-in: trace sites compile to nothing; the ungated raw writer (field
// diagnostics) goes to stderr when HARNESS_DIAG is set.
#include "harness_win.h"
#define DBG_FILE_LOG(expr) ((void)0)
inline const char* DbgFileLogPath() { return ""; }
// Every call is counted, shown or not: "diagnostics off writes nothing" is judged on
// the count (the row's diag_lines), so a missing gate cannot hide behind HARNESS_DIAG.
inline unsigned long& DbgFileLogWriteCount() { static unsigned long count = 0; return count; }
inline void DbgFileLogWrite(const char* msg)
{
    ++DbgFileLogWriteCount();
    if (std::getenv("HARNESS_DIAG") && msg) std::fprintf(stderr, "%s\n", msg);
}
