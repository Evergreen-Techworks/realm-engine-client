#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include "forwarders.g.h"
#include "connect_hook.h"
#include "splash_bypass.h"

static DWORD WINAPI InitThread(LPVOID) {
    // This whole thing is just to forward traffic to 127.0.0.1:2050 
    // so that we can intercept the packets before sending them to the server.
    // Avoid MinHook's thread suspension while Unity is inside il2cpp_init.
    Sleep(3000);
    InstallConnectHook();
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved) {
    switch (reason) {
        case DLL_PROCESS_ATTACH: {
            DisableThreadLibraryCalls(hinst);
            HANDLE t = CreateThread(nullptr, 0, InitThread, nullptr, 0, nullptr);
            if (t) CloseHandle(t);
            splashbypass::Install();
            break;
        }
        case DLL_PROCESS_DETACH:
            // reserved != NULL means the process is terminating: the loader
            // will not run any more code and the address space is about to go
            // away. MinHook's teardown does CreateToolhelp32Snapshot +
            // HeapAlloc + SuspendThread, all of it under the loader lock and
            // against threads that may already be dead. Skip it and let the
            // process die. (Only reserved == NULL - a real FreeLibrary - is
            // worth unhooking for.)
            if (reserved) break;
            splashbypass::Remove();
            RemoveConnectHook();
            break;
        default:
            break;
    }
    return TRUE;
}
