#pragma once
// Splash screen bypass (docs/plans/109, plan 110).
// Spawns a bootstrap thread at DLL attach; everything is fail-open.
namespace splashbypass {

// Starts the bootstrap thread. Safe to call once, from DllMain.
void Install();

// Removes the Update hook if installed. Safe to call unconditionally.
void Remove();

} // namespace splashbypass
