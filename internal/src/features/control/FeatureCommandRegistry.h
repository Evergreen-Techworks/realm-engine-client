// Purpose: defines the normalized feature-command payload and dispatcher used by
// the IPC bridge after command authentication succeeds.

// Helpful notes:
// - FeatureCommand stores small fixed buffers copied out of incoming JSON.
// - Apply routes known feature keys to their owning module or FeatureState.
// - ResolveHotkeyVk accepts friendly key names such as F-keys, numpad keys, and
//   common aliases before storing Windows virtual-key codes.

#pragma once

struct FeatureCommand {
    char key[64] = {};
    char valueType[8] = {};
    char value[128] = {};

    bool Is(const char* name) const;
    bool Bool() const;
    int Int() const;
    float Float() const;
};

namespace FeatureCommandRegistry {

bool Apply(const FeatureCommand& feature);
int ResolveHotkeyVk(const char* raw);

} // namespace FeatureCommandRegistry
