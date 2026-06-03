// Purpose: declares the runtime feature-application surface used by the IPC
// bridge and hook loop.

// Helpful notes:
// - ApplyOverrides pushes current FeatureState values into gameplay systems.
// - PollSocketHotkeyEvent reports edge-triggered socket hotkey presses so IPC can
//   emit a signed hotkey event back to the client.

#pragma once

namespace FeatureRuntime {

void ApplyOverrides();
bool PollSocketHotkeyEvent();

} // namespace FeatureRuntime
