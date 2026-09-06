#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include "../winhttp-proxy/src/splash_bypass.h"

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved)
{
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(instance);
        splashbypass::Install();
    } else if (reason == DLL_PROCESS_DETACH && !reserved) {
        splashbypass::Remove();
    }
    return TRUE;
}
