#pragma once

namespace ProjNoclip {

    // Install MinHook detours for HBEAKBIHANL.GJFKGLJEGKO and HBEAKBIHANL.IACODGNOFMH.
    // Safe to call multiple times; no-ops once installed.
    // Called from DetourInitilization() (lazy — resolves after IL2CPP is ready).
    void Install();
    void Uninstall();

    // Toggle projectile noclip at runtime.  Persisted across frames.
    void SetEnabled(bool on);
    bool IsEnabled();

    // True once both method hooks are live.
    bool IsInstalled();

} // namespace ProjNoclip
