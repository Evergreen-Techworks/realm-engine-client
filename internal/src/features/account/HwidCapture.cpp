#include "pch-il2cpp.h"
#include "HwidCapture.h"
#include "Il2CppResolver.h"
#include "Il2CppHook.h"
#include "DbgFileLog.h"
#include "helpers.h"
#include "ChatToast.h"

#include <atomic>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <windows.h>
#include <shlobj.h>

namespace HwidCapture {
namespace {

// ── State ────────────────────────────────────────────────────────────────
std::atomic<bool> s_captured       { false };
std::atomic<bool> s_forceRecapture { false };
std::mutex        s_valueMu;
std::string       s_lastValue;

// Resolved IL2CPP function pointer cache. Populated lazily on the first
// Tick that successfully resolves; cleared when we recapture.
using GetDeviceIdFn = app::String*(__fastcall*)(MethodInfo* method);
GetDeviceIdFn s_fnGetDeviceId = nullptr;
bool          s_resolved      = false;

// ── %LocalAppData%\RealmOfTheMadGod\hwid.txt ─────────────────────────────
// Same path the official Deca launcher writes to, and the same path
// bot-client/src/util/Hwid.ts reads as priority-1 source. Keeping the
// path identical means zero coordination cost — bot-client picks up our
// captured value automatically on its next launch, no IPC needed.
std::filesystem::path GetHwidFilePath()
{
    PWSTR raw = nullptr;
    if (SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &raw) != S_OK || !raw) {
        if (raw) CoTaskMemFree(raw);
        return {};
    }
    std::filesystem::path base = raw;
    CoTaskMemFree(raw);
    return base / "RealmOfTheMadGod" / "hwid.txt";
}

bool WriteHwidFile(const std::string& value)
{
    if (value.empty()) return false;
    auto path = GetHwidFilePath();
    if (path.empty()) return false;
    try {
        std::filesystem::create_directories(path.parent_path());
    } catch (...) {
        // Non-fatal — the dir almost always exists already (game was
        // installed there). Fall through to the open and let it fail
        // naturally if it really can't write.
    }
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    // Write the literal value with no trailing newline. The launcher
    // writes it the same way and bot-client's reader does .trim() so
    // either form would work, but matching the launcher's exact bytes
    // keeps any future strict comparison from tripping.
    f.write(value.data(), static_cast<std::streamsize>(value.size()));
    return f.good();
}

// ── IL2CPP resolution ────────────────────────────────────────────────────
// Resolves DeviceIdHolder.GetDeviceId — Deca's accessor that returns the
// cached SystemInfo.deviceUniqueIdentifier value. The IL2CPP dump shows
// it at GameAssembly.dll +0x002DDD30 with signature
//   String* DeviceIdHolder_GetDeviceId(MethodInfo* method)
// (no `this` because it's a static method).
//
// Falls back to UnityApiResultsHolder.GetDeviceUniqueIdentifier — same
// underlying value, deeper accessor used internally by Deca. If both
// fail, returns false and we retry on next Tick (Unity may not be ready
// yet).
bool ResolveOnce()
{
    if (s_resolved && s_fnGetDeviceId) return true;

    // Give up after 5 s — FindClassLoose scans all IL2CPP metadata and calling
    // it every frame for a BeeByte-renamed class tanks FPS permanently.
    static ULONGLONG s_firstTick = 0;
    static bool      s_gaveUp    = false;
    if (!s_gaveUp) {
        const ULONGLONG now = GetTickCount64();
        if (s_firstTick == 0) s_firstTick = now;
        s_gaveUp = (now - s_firstTick) >= 5000ULL;
    }
    if (s_gaveUp) return false;

    GetDeviceIdFn fn = nullptr;
    const MethodInfo* mi = Il2CppHook::ResolveMethodCached("DeviceIdHolder", "GetDeviceId", 0);
    if (mi) {
        fn = reinterpret_cast<GetDeviceIdFn>(mi->methodPointer);
    } else {
        // Fallback: deeper accessor — same value, more obfuscated path.
        mi = Il2CppHook::ResolveMethodCached("UnityApiResultsHolder", "GetDeviceUniqueIdentifier", 0);
        if (mi)
            fn = reinterpret_cast<GetDeviceIdFn>(mi->methodPointer);
    }
    if (!fn) return false;
    s_fnGetDeviceId = fn;
    s_resolved = true;
    return true;
}

// ── Capture (one-shot per session unless ForceRecapture set) ─────────────
bool DoCapture()
{
    if (!s_fnGetDeviceId) return false;
    app::String* result = nullptr;
    Resolver::Protection::safe_call([&]() {
        result = s_fnGetDeviceId(nullptr);
    });
    if (!result) return false;

    std::string value;
    try {
        value = il2cppi_to_string(result);
    } catch (...) {
        return false;
    }
    // Strip any whitespace the converter might have left (defensive —
    // the launcher's value is plain hex, but if Unity ever returns it
    // with surrounding whitespace, Deca compares literally).
    while (!value.empty() && (value.back() == '\n' || value.back() == '\r' || value.back() == ' ' || value.back() == '\t')) {
        value.pop_back();
    }
    if (value.empty()) return false;

    if (!WriteHwidFile(value)) {
        DBG_FILE_LOG("[hwid] capture got value but failed to write hwid.txt");
        ChatToast::Push(ChatToast::Kind::Error,
                        "HWID captured but file write failed. Check that "
                        "%LocalAppData%\\RealmOfTheMadGod is writable.");
        return false;
    }

    // Detect "first capture this session" so we only toast once. Subsequent
    // recaptures (after ForceRecaptureNextTick or value drift) update the
    // file silently — no need to nag the user about routine refreshes.
    const bool firstThisSession = !s_captured.exchange(true, std::memory_order_acq_rel);

    {
        std::lock_guard<std::mutex> g(s_valueMu);
        s_lastValue = value;
    }

    DBG_FILE_LOG("[hwid] captured + wrote hwid.txt (" << value.size() << " chars)");

    if (firstThisSession) {
        // User-facing notification — the captured value only takes effect
        // after the bot-client re-reads hwid.txt at its next launch. Tell
        // the user explicitly so they know to restart the launcher.
        ChatToast::Push(ChatToast::Kind::Success,
                        "HWID captured. Close and re-open the bot-client "
                        "launcher to apply (login will succeed on retry).");
    }
    return true;
}

} // namespace

// ── Public API ───────────────────────────────────────────────────────────
bool Tick()
{
    // Idempotent fast-path. Once we've captured for this session AND
    // nobody requested a recapture, the rest of the function is dead
    // weight on the per-frame caller — exit cheap.
    if (s_captured.load(std::memory_order_acquire) &&
        !s_forceRecapture.load(std::memory_order_acquire)) {
        return true;
    }

    if (!ResolveOnce()) {
        // Unity / IL2CPP not ready yet; try again next frame. Common
        // during the first ~30 frames after the game starts, before
        // GameAssembly.dll's static init finishes. No-log to avoid
        // spamming during normal startup.
        return false;
    }

    if (DoCapture()) {
        s_forceRecapture.store(false, std::memory_order_release);
        return true;
    }
    return false;
}

bool IsCaptured()
{
    return s_captured.load(std::memory_order_acquire);
}

const char* GetLastCapturedValue()
{
    // Thread-safety here is loose by design — this is for the debug
    // overlay only. Returning a pointer into the std::string is safe
    // because we only ever assign-replace the string under the mutex
    // and never deallocate it after the first write.
    std::lock_guard<std::mutex> g(s_valueMu);
    return s_lastValue.c_str();
}

void ForceRecaptureNextTick()
{
    s_captured.store(false, std::memory_order_release);
    s_forceRecapture.store(true, std::memory_order_release);
}

} // namespace HwidCapture
