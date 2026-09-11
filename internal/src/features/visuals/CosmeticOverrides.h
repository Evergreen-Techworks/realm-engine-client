#pragma once

// ─────────────────────────────────────────────────────────────────────────────
// CosmeticOverrides — local-only title, entrance and pet-skin overrides.
//
// These three cosmetics used to be driven by writing the account/wardrobe
// managers hanging off ApplicationManager. That never showed up in the world:
// those managers only feed the wardrobe UI and the outgoing "commit to my
// account" packets, and nothing on the render path reads them back. Each
// override therefore drives the same game call the renderer itself uses.
//
// Nothing here sends a packet — every effect is a purely local illusion.
// ─────────────────────────────────────────────────────────────────────────────

namespace CosmeticOverrides {

// Per-frame reconciliation. Call from the render thread (FeatureRuntime).
void Tick();

// Raised by SkinChanger after it writes the skin field. The HUD portrait is a
// cached sprite that otherwise only reloads on world entry; the reload itself
// is deferred to the next Tick() so the IL2CPP call stays on the render path.
void RequestCharacterIconRefresh();

} // namespace CosmeticOverrides
