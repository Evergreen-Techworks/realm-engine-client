#include "pch-il2cpp.h"
#include "CredentialCapture.h"
#include "Il2CppResolver.h"
#include "platform/hooks/Il2CppHook.h"
#include "DbgFileLog.h"
#include "helpers.h"

#include "minhook/MinHook.h"

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <windows.h>
#include <shlobj.h>

namespace CredentialCapture {
namespace {

// ── Persistent file path ────────────────────────────────────────────────
// Same directory the Deca launcher uses for hwid.txt, so bot-client knows
// where to look (mirrors HwidCapture's convention — zero-coordination).
std::filesystem::path GetLogFilePath()
{
    PWSTR raw = nullptr;
    if (SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &raw) != S_OK || !raw) {
        if (raw) CoTaskMemFree(raw);
        return {};
    }
    std::filesystem::path base = raw;
    CoTaskMemFree(raw);
    return base / "RealmOfTheMadGod" / "re-captured-creds.jsonl";
}

// ── State ───────────────────────────────────────────────────────────────
std::atomic<bool> s_resolved        { false };
std::atomic<bool> s_hooksInstalled  { false };
std::mutex        s_steamIdMu;
std::string       s_lastSteamId;          // last value passed to SetSteamId
std::mutex        s_writeMu;              // serialize JSONL appends

// ── Original function pointers ──────────────────────────────────────────
using ConnectFn    = void(__fastcall*)(void* __this, app::String* guid, app::String* secret, app::String* clientToken, MethodInfo* method);
using SetSteamIdFn = void(__fastcall*)(void* __this, app::String* steamId, MethodInfo* method);

void*        s_connectTarget    = nullptr;
void*        s_setSteamIdTarget = nullptr;
ConnectFn    s_origConnect      = nullptr;
SetSteamIdFn s_origSetSteamId   = nullptr;

// ── JSON helpers (minimal — we're not pulling in a library) ─────────────
std::string JsonEscape(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
                    out += buf;
                } else {
                    out += c;
                }
                break;
        }
    }
    return out;
}

std::string SafeStringFromIl2cpp(app::String* s)
{
    if (!s) return {};
    std::string out;
    try {
        out = il2cppi_to_string(s);
    } catch (...) {
        out.clear();
    }
    return out;
}

void AppendRecord(const std::string& guid, const std::string& secret,
                  const std::string& clientToken, const std::string& steamId)
{
    auto path = GetLogFilePath();
    if (path.empty()) return;

    try {
        std::filesystem::create_directories(path.parent_path());
    } catch (...) { /* dir almost always already exists */ }

    int64_t ts = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();

    std::string line;
    line.reserve(256);
    line += "{\"timestamp\":";
    line += std::to_string(ts);
    line += ",\"guid\":\"";        line += JsonEscape(guid);        line += '"';
    line += ",\"secret\":\"";      line += JsonEscape(secret);      line += '"';
    line += ",\"clientToken\":\""; line += JsonEscape(clientToken); line += '"';
    line += ",\"steamId\":\"";     line += JsonEscape(steamId);     line += '"';
    line += "}\n";

    std::lock_guard<std::mutex> lk(s_writeMu);
    std::ofstream f(path, std::ios::binary | std::ios::app);
    if (!f) return;
    f.write(line.data(), static_cast<std::streamsize>(line.size()));
}

// ── Detours ─────────────────────────────────────────────────────────────
void __fastcall HookedConnect(void* __this, app::String* guid, app::String* secret,
                              app::String* clientToken, MethodInfo* method)
{
    // Call the original FIRST so the live login proceeds unchanged even if our
    // capture logic throws below.
    if (s_origConnect) s_origConnect(__this, guid, secret, clientToken, method);

    try {
        std::string g  = SafeStringFromIl2cpp(guid);
        std::string s_ = SafeStringFromIl2cpp(secret);
        std::string ct = SafeStringFromIl2cpp(clientToken);
        std::string sid;
        {
            std::lock_guard<std::mutex> lk(s_steamIdMu);
            sid = s_lastSteamId;
        }
        if (!g.empty() || !s_.empty()) {
            AppendRecord(g, s_, ct, sid);
            DBG_FILE_LOG("[credcap] captured login: guid="
                << (g.empty() ? "(empty)" : g)
                << " secretLen=" << s_.size()
                << " steam=" << (sid.empty() ? "no" : sid));
        }
    } catch (...) {
        DBG_FILE_LOG("[credcap] capture threw in Connect detour (ignored)");
    }
}

void __fastcall HookedSetSteamId(void* __this, app::String* steamId, MethodInfo* method)
{
    if (s_origSetSteamId) s_origSetSteamId(__this, steamId, method);

    try {
        std::string sid = SafeStringFromIl2cpp(steamId);
        std::lock_guard<std::mutex> lk(s_steamIdMu);
        s_lastSteamId = sid;
    } catch (...) { /* ignore */ }
}

// ── IL2CPP resolution + MinHook install ─────────────────────────────────
void TryInstall()
{
    if (s_hooksInstalled.load(std::memory_order_acquire)) return;

    // Exact (readable) class name — resolve with loose=false (Resolver::GetClass).
    void* connectFn  = Il2CppHook::ResolveMethod("AppEngineManager", "Connect", 3, /*loose*/false);
    void* setSteamFn = Il2CppHook::ResolveMethod("AppEngineManager", "SetSteamId", 1, /*loose*/false);

    if (!connectFn) {
        // Game/IL2CPP isn't ready yet — retry on next Tick.
        return;
    }

    s_connectTarget    = connectFn;
    s_setSteamIdTarget = setSteamFn;

    if (!Il2CppHook::InstallMinHook(s_connectTarget,
            reinterpret_cast<void*>(&HookedConnect),
            reinterpret_cast<void**>(&s_origConnect), "credcap.Connect")) {
        s_connectTarget = nullptr;
        return;
    }

    if (s_setSteamIdTarget) {
        // Non-fatal — Steam-flow accounts simply won't have a steamId
        // captured. Connect-only capture still works.
        if (!Il2CppHook::InstallMinHook(s_setSteamIdTarget,
                reinterpret_cast<void*>(&HookedSetSteamId),
                reinterpret_cast<void**>(&s_origSetSteamId), "credcap.SetSteamId")) {
            s_setSteamIdTarget = nullptr;
        }
    }

    s_hooksInstalled.store(true, std::memory_order_release);
    DBG_FILE_LOG("[credcap] hooks installed (Connect"
        << (s_setSteamIdTarget ? " + SetSteamId" : "")
        << "). Logging to "
        << GetLogFilePath().string());
}

} // anonymous namespace

void Tick()
{
    if (s_resolved.load(std::memory_order_acquire)) return;
    TryInstall();
    if (s_hooksInstalled.load(std::memory_order_acquire)) {
        s_resolved.store(true, std::memory_order_release);
    }
}

void Uninstall()
{
    if (!s_hooksInstalled.load(std::memory_order_acquire)) return;

    if (s_connectTarget) {
        MH_DisableHook(s_connectTarget);
        MH_RemoveHook(s_connectTarget);
        s_connectTarget = nullptr;
    }
    if (s_setSteamIdTarget) {
        MH_DisableHook(s_setSteamIdTarget);
        MH_RemoveHook(s_setSteamIdTarget);
        s_setSteamIdTarget = nullptr;
    }
    s_origConnect    = nullptr;
    s_origSetSteamId = nullptr;
    s_hooksInstalled.store(false, std::memory_order_release);
    s_resolved.store(false, std::memory_order_release);
    DBG_FILE_LOG("[credcap] uninstalled");
}

} // namespace CredentialCapture
