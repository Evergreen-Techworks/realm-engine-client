#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include "forwarders.g.h"
#include "connect_hook.h"
#include "splash_bypass.h"

static DWORD WINAPI InitThread(LPVOID) {
    // This whole thing is just to forward traffic to 127.0.0.1:2050 
    // so that we can intercept the packets before sending them to the server.
    InstallConnectHook();
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID /*reserved*/) {
    switch (reason) {
        case DLL_PROCESS_ATTACH: {
            DisableThreadLibraryCalls(hinst);
            HANDLE t = CreateThread(nullptr, 0, InitThread, nullptr, 0, nullptr);
            if (t) CloseHandle(t);
            splashbypass::Install();
            break;
        }
        case DLL_PROCESS_DETACH:
            splashbypass::Remove();
            RemoveConnectHook();
            break;
        default:
            break;
    }
    return TRUE;
}
