// dllmain.cpp
#include "pch-il2cpp.h"
#include <windows.h>
#include "main.h"
#include "InitHooks.h"
#include "DbgFileLog.h"

BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved)
{
    switch (ul_reason_for_call)
    {
    case DLL_PROCESS_ATTACH:
        DisableThreadLibraryCalls(hModule);
        CreateThread(NULL, 0, (LPTHREAD_START_ROUTINE)Run, hModule, NULL, NULL);
        break;

    case DLL_PROCESS_DETACH:
        // Item 4 (navigation finish plan): DbgFileLogWrite buffers now; flush
        // whatever is still queued before the DLL goes away. try_lock inside
        // (DbgFileLogEnterCrashMode), so this cannot hang the loader lock.
        DbgFileLogEnterCrashMode();
        if (lpReserved == nullptr) {
            DetourUninitialization();
        }
        break;
    }
    return TRUE;
}
