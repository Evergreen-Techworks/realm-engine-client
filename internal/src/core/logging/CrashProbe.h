#pragma once
// CrashProbe — logs the exact faulting module+offset, registers, and a stack
// backtrace to the DLL trace log when the process hits a fatal exception.
//
// A vectored exception handler (first-chance) is the primary catch: it fires
// before any SEH frame handler or unhandled-exception filter, so it captures
// the crash even if the game/mono owns the unhandled filter. We only act on
// genuinely fatal codes (AV, stack overflow, etc.) and always return
// EXCEPTION_CONTINUE_SEARCH so normal handling/termination is unchanged.
//
// Output lands in the same file as DBG_FILE_LOG:
//   %LOCALAPPDATA%\RotMG Exalt DLL Trace.log

#include <Windows.h>
#include <cstdint>
#include <cstdio>
#include "DbgFileLog.h"

namespace crashprobe {

inline void DescribeAddr(void* addr, char* out, size_t outSz)
{
    HMODULE mod = nullptr;
    if (GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(addr), &mod) && mod) {
        wchar_t pathW[MAX_PATH] = {};
        GetModuleFileNameW(mod, pathW, MAX_PATH);
        const wchar_t* base = pathW;
        for (const wchar_t* p = pathW; *p; ++p)
            if (*p == L'\\' || *p == L'/') base = p + 1;
        char nameA[MAX_PATH] = {};
        WideCharToMultiByte(CP_UTF8, 0, base, -1, nameA, sizeof(nameA), nullptr, nullptr);
        uintptr_t off = reinterpret_cast<uintptr_t>(addr) - reinterpret_cast<uintptr_t>(mod);
        snprintf(out, outSz, "%s+0x%llx (base=%p)", nameA,
                 static_cast<unsigned long long>(off), reinterpret_cast<void*>(mod));
    } else {
        snprintf(out, outSz, "%p (no module)", addr);
    }
}

typedef USHORT(WINAPI* pRtlCaptureStackBackTrace)(ULONG, ULONG, PVOID*, PULONG);

inline void LogException(EXCEPTION_POINTERS* ep, const char* tag)
{
    if (!ep || !ep->ExceptionRecord) {
        DbgFileLogWrite("[CrashProbe] (null exception pointers)");
        return;
    }
    // Item 4 (navigation finish plan): DbgFileLogWrite buffers by default now.
    // Flush whatever is queued and switch to unbuffered writes for the rest of
    // this crash report (and anything after it) BEFORE writing a single line of
    // the report itself, so a process that dies moments later still has every
    // line on disk.
    DbgFileLogEnterCrashMode();
    EXCEPTION_RECORD* er = ep->ExceptionRecord;
    CONTEXT* cx = ep->ContextRecord;
    char line[1024];
    char addrDesc[512];
    DescribeAddr(er->ExceptionAddress, addrDesc, sizeof(addrDesc));

    const char* codeName = "UNKNOWN";
    switch (er->ExceptionCode) {
        case EXCEPTION_ACCESS_VIOLATION:    codeName = "ACCESS_VIOLATION"; break;
        case EXCEPTION_STACK_OVERFLOW:      codeName = "STACK_OVERFLOW"; break;
        case EXCEPTION_ILLEGAL_INSTRUCTION: codeName = "ILLEGAL_INSTRUCTION"; break;
        case EXCEPTION_PRIV_INSTRUCTION:    codeName = "PRIV_INSTRUCTION"; break;
        case EXCEPTION_INT_DIVIDE_BY_ZERO:  codeName = "INT_DIVIDE_BY_ZERO"; break;
        case EXCEPTION_IN_PAGE_ERROR:       codeName = "IN_PAGE_ERROR"; break;
        case 0xC0000374:                    codeName = "HEAP_CORRUPTION"; break;
        default: break;
    }
    snprintf(line, sizeof(line), "[CrashProbe] %s code=0x%08lx (%s) at %s",
             tag, er->ExceptionCode, codeName, addrDesc);
    DbgFileLogWrite(line);

    if (er->ExceptionCode == EXCEPTION_ACCESS_VIOLATION && er->NumberParameters >= 2) {
        const char* op = er->ExceptionInformation[0] == 0 ? "READ"
                       : er->ExceptionInformation[0] == 1 ? "WRITE"
                       : er->ExceptionInformation[0] == 8 ? "EXECUTE" : "?";
        snprintf(line, sizeof(line), "[CrashProbe]   AV %s of address %p",
                 op, reinterpret_cast<void*>(er->ExceptionInformation[1]));
        DbgFileLogWrite(line);
    }

#ifdef _M_X64
    if (cx) {
        snprintf(line, sizeof(line),
            "[CrashProbe]   RIP=%p RSP=%p RBP=%p RAX=%p RBX=%p RCX=%p RDX=%p RSI=%p RDI=%p R8=%p R9=%p",
            reinterpret_cast<void*>(cx->Rip), reinterpret_cast<void*>(cx->Rsp),
            reinterpret_cast<void*>(cx->Rbp), reinterpret_cast<void*>(cx->Rax),
            reinterpret_cast<void*>(cx->Rbx), reinterpret_cast<void*>(cx->Rcx),
            reinterpret_cast<void*>(cx->Rdx), reinterpret_cast<void*>(cx->Rsi),
            reinterpret_cast<void*>(cx->Rdi), reinterpret_cast<void*>(cx->R8),
            reinterpret_cast<void*>(cx->R9));
        DbgFileLogWrite(line);
        char ripDesc[512];
        DescribeAddr(reinterpret_cast<void*>(cx->Rip), ripDesc, sizeof(ripDesc));
        snprintf(line, sizeof(line), "[CrashProbe]   RIP -> %s", ripDesc);
        DbgFileLogWrite(line);
    }
#endif

    static pRtlCaptureStackBackTrace capture = nullptr;
    if (!capture) {
        HMODULE nt = GetModuleHandleW(L"ntdll.dll");
        if (nt) capture = reinterpret_cast<pRtlCaptureStackBackTrace>(
                              GetProcAddress(nt, "RtlCaptureStackBackTrace"));
    }
    if (capture) {
        void* frames[48] = {};
        USHORT n = capture(0, 48, frames, nullptr);
        for (USHORT i = 0; i < n; ++i) {
            char fd[512];
            DescribeAddr(frames[i], fd, sizeof(fd));
            snprintf(line, sizeof(line), "[CrashProbe]   #%02u %s", i, fd);
            DbgFileLogWrite(line);
        }
    }
    DbgFileLogWrite("[CrashProbe] ---- end ----");
}

inline bool IsFatal(DWORD code)
{
    switch (code) {
        case EXCEPTION_ACCESS_VIOLATION:
        case EXCEPTION_STACK_OVERFLOW:
        case EXCEPTION_ILLEGAL_INSTRUCTION:
        case EXCEPTION_PRIV_INSTRUCTION:
        case EXCEPTION_INT_DIVIDE_BY_ZERO:
        case EXCEPTION_IN_PAGE_ERROR:
        case 0xC0000374: // heap corruption
            return true;
        default:
            return false;
    }
}

inline LONG WINAPI VectoredHandler(EXCEPTION_POINTERS* ep)
{
    static LONG count = 0;
    if (ep && ep->ExceptionRecord && IsFatal(ep->ExceptionRecord->ExceptionCode)) {
        if (InterlockedIncrement(&count) <= 8)
            LogException(ep, "first-chance");
    }
    return EXCEPTION_CONTINUE_SEARCH;
}

inline LONG WINAPI TopLevelHandler(EXCEPTION_POINTERS* ep)
{
    LogException(ep, "UNHANDLED/terminal");
    return EXCEPTION_CONTINUE_SEARCH;
}

inline void InstallCrashProbe()
{
    DbgFileLogWrite("[CrashProbe] installing handlers...");
    AddVectoredExceptionHandler(1, VectoredHandler);
    SetUnhandledExceptionFilter(TopLevelHandler);
    DbgFileLogWrite("[CrashProbe] handlers installed.");
}

} // namespace crashprobe
