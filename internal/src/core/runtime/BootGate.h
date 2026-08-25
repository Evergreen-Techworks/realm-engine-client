#pragma once

// BootGate — boot gating loop.
//
// Ticked once per frame from dPresent. Runs offset resolution by name, audits
// against the dependency ledger + live values, and gates feature installs on
// the result — so a stale offset after a patch can never silently drive a
// broken feature.
namespace BootGate {

    enum class State {
        WaitingForMetadata, // IL2CPP up but not in a world yet (classes lazy-load)
        Resolving,          // RuntimeOffsets::EnsureAll() name pass running
        Auditing,           // classify every critical anchor OK / stale vs the ledger
        Ready,              // settled; healthy features may install, degraded stay off
    };

    // Drive the loop one frame. Returns the (possibly advanced) current state.
    State Tick();
    // Force a re-audit on the next Tick (e.g. after a world/character reload).
    void  RequestRecheck();

    // ── Feature gate ─────────────────────────────────────────────────────────
    // May this feature install its hooks yet? Fail-closed: false until Ready AND
    // every critical anchor the feature needs is healthy. Call at the top of each
    // feature Install(). An unregistered feature name is never gated (returns true).
    bool FeatureAllowed(const char* feature);

    // ── Health surface ───────────────────────────────────────────────────────
    // True once the audit has run at least once and a critical dep is stale.
    bool Degraded();

} // namespace BootGate
