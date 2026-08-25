#pragma once
#include <cstdint>

// AutoFire — hold-to-continuously-fire. Drives the game's own shoot entry so the
// game's rate limit applies. Owns NO hook (that is why it publishes a liveness
// stamp). Ticked from CombatTAB::Tick on the render thread.
namespace AutoFire {

void Tick(bool menuOpen);

void SetEnabled(bool on);      bool IsEnabled();     // master switch, default OFF
void SetHotkeyVk(int vk);      int  GetHotkeyVk();   // 0 = unbound (never fires)
void SetSlot(int slot);        int  GetSlot();       // diagnostic, clamp [0,3], default 0

// Programmatic engage, independent of the hotkey. Used by auto-break-walls
// (plan 89). Reference-free boolean: last writer wins, cleared on disable.
void SetAutoEngage(bool on);   bool IsAutoEngaged();

struct Diag {
    bool     resolved   = false;  // ShootRuntime bound
    bool     gated      = false;  // BootGate refused
    bool     engaged    = false;  // hotkey down OR auto-engage
    bool     lastCanShoot = false;
    uint32_t shotsSent  = 0;
    uint32_t framesEngaged = 0;
};
Diag GetDiag();

void RenderSettings();   // render thread

} // namespace AutoFire
