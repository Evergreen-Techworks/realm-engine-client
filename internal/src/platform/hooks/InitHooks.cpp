#include "pch-il2cpp.h"
#include <Windows.h>
#include <iostream>
#include <mutex>
#include "detours/detours.h"
#include "minhook/MinHook.h"
#include "InitHooks.h"
#include "DirectX.h"
#include "Dx11.h"
#include "ProjectileTracking.h"
#include "AutoAim.h"
#include "AoeTracking.h"
#include "SpeedHack.h"
#include "ProjNoclip.h"
#include "NoclipHook.h"
#include "IpcBridge.h"
#include "DbgFileLog.h"
#include "DangerPlanner.h"
#include "features/movement/udodge/UDodge.h"

bool HookFunction(PVOID* ppPointer, PVOID pDetour, const char* functionName) {
    if (const auto error = DetourAttach(ppPointer, pDetour); error != NO_ERROR) {
        std::cout << "[ERROR]: Failed to hook " << functionName << ", error " << error << std::endl;
        return false;
    }
    std::cout << "[HOOKED]: " << functionName << std::endl;
    return true;
}

bool UnhookFunction(PVOID* ppPointer, PVOID pDetour, const char* functionName) {
    if (const auto error = DetourDetach(ppPointer, pDetour); error != NO_ERROR) {
        std::cout << "[ERROR]: Failed to unhook " << functionName << ", error " << error << std::endl;
        return false;
    }
    std::cout << "[UNHOOKED]: " << functionName << std::endl;
    return true;
}

void DetourInitilization() {
    DBG_FILE_LOG("[DetourInit] Entering DetourInitilization...");
    DetourTransactionBegin();
    DBG_FILE_LOG("[DetourInit] DetourTransactionBegin done.");
    DetourUpdateThread(GetCurrentThread());
    DBG_FILE_LOG("[DetourInit] DetourUpdateThread done.");

    DBG_FILE_LOG("[DetourInit] Constructing dx11api (creates temp D3D11 device)...");
    dx11api d3d11 = dx11api();
    DBG_FILE_LOG("[DetourInit] dx11api constructor returned. presentFunction=" << (void*)d3d11.presentFunction);

    if (!d3d11.presentFunction) {
        std::cout << "[ERROR]: Unable to retrieve IDXGISwapChain::Present method" << std::endl;
        return;
    }

    oPresent = d3d11.presentFunction;

    if (!oPresent) {
        std::cout << "[ERROR]: oPresent is null!" << std::endl;
        return;
    }

    std::cout << "[INFO]: Attempting to hook oPresent at address: " << oPresent << std::endl;

    if (!HookFunction(&(PVOID&)oPresent, dPresent, "D3D_PRESENT_FUNCTION")) {
        DetourTransactionAbort();
        return;
    }

    DetourTransactionCommit();
    DBG_FILE_LOG("[DetourInit] DetourTransactionCommit done.");

    // ProjectileTracking and AutoAim use IL2CPP runtime resolution.
    // They self-install lazily from dPresent (Tick) once the game is initialized.

}

void DetourUninitialization()
{
    static std::once_flag s_uninitOnce;
    std::call_once(s_uninitOnce, []() {
        // 0) Stop the IPC bridge thread first so the pipe disconnects cleanly.
        IpcBridge_RequestShutdown();

        // 1) Restore clean game state before tearing down DirectX.
        SpeedHack::SetMultiplier(1.0f);

        // 2) Stop ImGui / WndProc / D3D while Present is still hooked but short-circuited via g_unloading.
        DirectX::Shutdown();

        // 3) Remove IL2CPP MinHook targets before MinHook uninit.
        NoclipHook::Uninstall();
        SpeedHack::Uninstall();
        DangerPlanner::Uninstall();
        ProjNoclip::Uninstall();
        AoeTracking::Uninstall();
        AutoAim::Uninstall();
        ProjectileTracking::Uninstall();

        // Disable UDodge before DLL unload so it stops driving movement and
        // clears its published state. SetEnabled(false) also Stop()s + JOINs the
        // plan-65 async grid-pathfinder worker, so no thread outlives the DLL
        // (Worker::Stop is idempotent — safe if UDodge was never enabled).
        // DangerPlanner::Uninstall() above has already stopped the game-thread
        // Tick that feeds it.
        UDodge::SetEnabled(false);

        // 4) Disable any remaining MinHook hooks, then release the library (safe if never initialized).
        MH_DisableHook(MH_ALL_HOOKS);
        MH_Uninitialize();

        // 5) Detach DXGI Present last so the render thread stops entering our detour.
        if (oPresent) {
            DetourTransactionBegin();
            DetourUpdateThread(GetCurrentThread());
            const LONG detachErr = DetourDetach(&(PVOID&)oPresent, dPresent);
            if (detachErr != NO_ERROR) {
                DetourTransactionAbort();
            } else if (DetourTransactionCommit() != NO_ERROR) {
                DetourTransactionAbort();
            }
        }
        oPresent = nullptr;
    });
}
