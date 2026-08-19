#pragma once

#include "UDodgeTypes.h"

namespace UDodge { namespace Debug {

// Render the world overlay from a published snapshot (render thread).
void Render(const DebugSnapshot& snap,
            float camX, float camY, float angle, float zoom, float cx, float cy);

} } // namespace UDodge::Debug
