// injector.exe — Standalone DLL injector for realm-engine.dll
// Uses CreateRemoteThread + LoadLibraryW (same technique as ExtremeInjector's
// standard injection). Takes PID + DLL path as args, outputs JSON to stdout.
//
// Exit codes: 0=ok, 1=args, 2=OpenProcess, 3=alloc, 4=write, 5=thread, 6=load-fail

#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

static void jsonOk()
{
    printf("{\"ok\":true}\n");
}

static void jsonError(const char* msg, int exitCode)
{
    printf("{\"ok\":false,\"error\":\"%s\"}\n", msg);
    exit(exitCode);
}

static void enableDebugPrivilege()
{
    HANDLE hToken = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hToken))
        return;
    TOKEN_PRIVILEGES tp{};
    if (LookupPrivilegeValueW(nullptr, SE_DEBUG_NAME, &tp.Privileges[0].Luid)) {
        tp.PrivilegeCount = 1;
        tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
        AdjustTokenPrivileges(hToken, FALSE, &tp, sizeof(tp), nullptr, nullptr);
    }
    CloseHandle(hToken);
}

int main(int argc, char* argv[])
{
    if (argc < 3) {
        fprintf(stderr, "Usage: injector.exe <PID> <DLL path>\n");
        jsonError("usage: injector.exe <PID> <DLL path>", 1);
    }

    DWORD pid = static_cast<DWORD>(strtoul(argv[1], nullptr, 10));
    const char* dllPath = argv[2];

    if (pid == 0)
        jsonError("invalid PID", 1);

    enableDebugPrivilege();

    HANDLE hProcess = OpenProcess(
        PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
        PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
        FALSE, pid);
    if (!hProcess)
        jsonError("OpenProcess failed", 2);

    size_t pathLen = strlen(dllPath) + 1;
    void* remoteMem = VirtualAllocEx(hProcess, nullptr, pathLen, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remoteMem) {
        CloseHandle(hProcess);
        jsonError("VirtualAllocEx failed", 3);
    }

    if (!WriteProcessMemory(hProcess, remoteMem, dllPath, pathLen, nullptr)) {
        VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
        CloseHandle(hProcess);
        jsonError("WriteProcessMemory failed", 4);
    }

    HMODULE hKernel32 = GetModuleHandleA("kernel32.dll");
    FARPROC pLoadLibrary = GetProcAddress(hKernel32, "LoadLibraryA");

    HANDLE hThread = CreateRemoteThread(
        hProcess, nullptr, 0,
        reinterpret_cast<LPTHREAD_START_ROUTINE>(pLoadLibrary),
        remoteMem, 0, nullptr);
    if (!hThread) {
        VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
        CloseHandle(hProcess);
        jsonError("CreateRemoteThread failed", 5);
    }

    WaitForSingleObject(hThread, 10000);

    DWORD exitCode = 0;
    GetExitCodeThread(hThread, &exitCode);

    CloseHandle(hThread);
    VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
    CloseHandle(hProcess);

    if (exitCode == 0)
        jsonError("LoadLibrary returned NULL (DLL load failed)", 6);

    jsonOk();
    return 0;
}
