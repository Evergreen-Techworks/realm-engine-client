#pragma once
#include <cstdint>

// AutoFire — native auto-fire. Owns NO hook (that is why it publishes a liveness
// stamp). Two triggers, rules in modes/AutoFireDecision.h:
//
//   Manual  hold the bound hotkey (or auto-break-walls' engage). Ticked from
//           CombatTAB::Tick on the render thread, unchanged.
//   Script  a script's autoFireEnabled. Fires by itself, but only at a real Auto
//           Aim target that is in the enemy snapshot, alive and in range — never
//           toward the cursor. Runs on the game-update thread (GameThreadTick,
//           called from the AppEngineManager.Update detour DangerPlanner owns),
//           through the game's own ShootWithAngle.
namespace AutoFire {

void Tick(bool menuOpen);      // render thread (manual trigger)
void GameThreadTick();         // game-update thread (script trigger); SEH-guarded

void SetEnabled(bool on);      bool IsEnabled();     // master switch, default OFF; off also disarms the script trigger
void SetHotkeyVk(int vk);      int  GetHotkeyVk();   // 0 = unbound (never fires)
void SetSlot(int slot);        int  GetSlot();       // diagnostic, clamp [0,3], default 0

// The script trigger. Feature command "autoFireEnabled" (scripts only; the in-game
// checkbox calls SetEnabled). Arming also turns the master switch on, as the
// command always has; disarming turns it off.
void SetScriptArmed(bool on);  bool IsScriptArmed();

// A new map connection (the client's HELLO). Stops the script trigger until the
// new map settles. Any thread.
void NotifyMapChange();

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
    bool        scriptArmed  = false;
    const char* scriptState  = "not-armed";  // AutoFireDecision::Name of the last script step
    uint32_t    scriptPulls  = 0;            // ShootWithAngle calls by the script trigger (the game's timer decides which become shots)
};
Diag GetDiag();

void RenderSettings();   // render thread

} // namespace AutoFire
