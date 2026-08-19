#include "pch-il2cpp.h"
#include "DiagBridge.h"
#include "BootGate.h"
#include "RuntimeOffsets.h"
#include "LocalPlayer.h"
#include "GameState.h"
#include "Il2CppResolver.h"
#include "DbgFileLog.h"
#include "RePP.h"
#include "PJDodge.h"
#include "features/movement/udodge/UDodge.h"
#include "settings.h"

#include <Windows.h>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cstdlib>

// Forward-declared to avoid pulling the GUI-heavy AoeTracking.h / WorldTAB.h into core/runtime.
namespace AoeTracking { void GetGjjProbe(bool& resolved, uint32_t& originOff, uint32_t& destOff); }
namespace WorldTAB    { void* GetSampleTilePtr(); }

namespace DiagBridge {
namespace {

const char* StateName(BootGate::State s) {
    switch (s) {
        case BootGate::State::WaitingForMetadata: return "WaitingForMetadata";
        case BootGate::State::Resolving:          return "Resolving";
        case BootGate::State::Auditing:           return "Auditing";
        case BootGate::State::Ready:              return "Ready";
    }
    return "Unknown";
}

const char* FrameStatusName(int s) {
    static const char* k[] = {
        "Disabled", "NoPlayer", "NoThreats", "IntentSafe", "SlideAssist",
        "CandidateAssist", "FieldEscape", "NoSafeCandidate", "MovementFailed", "SensorLimited" };
    return (s >= 0 && s < 10) ? k[s] : "Unknown";
}

// %LOCALAPPDATA%\RealmEngine (dir created on first call). nullptr if unavailable.
const char* DiagDir() {
    static char s_dir[MAX_PATH] = {};
    static bool s_tried = false;
    if (s_tried) return s_dir[0] ? s_dir : nullptr;
    s_tried = true;
    char local[MAX_PATH] = {};
    DWORD n = GetEnvironmentVariableA("LOCALAPPDATA", local, sizeof(local));
    if (n == 0 || n >= sizeof(local)) return nullptr;
    snprintf(s_dir, sizeof(s_dir), "%s\\RealmEngine", local);
    CreateDirectoryA(s_dir, nullptr);
    return s_dir;
}

void AtomicWrite(const char* path, const char* data, int len) {
    char tmp[MAX_PATH];
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    FILE* f = nullptr;
    if (fopen_s(&f, tmp, "wb") != 0 || !f) return;
    fwrite(data, 1, static_cast<size_t>(len), f);
    fclose(f);
    MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING);
}

int ReadFileSmall(const char* path, char* buf, int bufSz) {
    FILE* f = nullptr;
    if (fopen_s(&f, path, "rb") != 0 || !f) return -1;
    size_t n = fread(buf, 1, static_cast<size_t>(bufSz) - 1, f);
    fclose(f);
    buf[n] = 0;
    return static_cast<int>(n);
}

// ── minimal JSON field extraction (for the controlled cmd.json) ──────────────
const char* FindKey(const char* s, const char* key) {
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char* p = strstr(s, pat);
    if (!p) return nullptr;
    p += strlen(pat);
    while (*p && *p != ':') ++p;
    if (*p != ':') return nullptr;
    ++p;
    while (*p == ' ' || *p == '\t') ++p;
    return p;
}
bool JsonInt(const char* s, const char* key, long long& out) {
    const char* p = FindKey(s, key);
    if (!p) return false;
    out = strtoll(p, nullptr, 10);
    return true;
}
bool JsonStr(const char* s, const char* key, char* out, int outSz) {
    const char* p = FindKey(s, key);
    if (!p || *p != '"') { if (outSz) out[0] = 0; return false; }
    ++p;
    int i = 0;
    while (*p && *p != '"' && i < outSz - 1) out[i++] = *p++;
    out[i] = 0;
    return true;
}

ULONGLONG s_lastSnapMs = 0;
ULONGLONG s_lastCmdMs  = 0;
long long s_lastCmdId  = 0;
uint64_t  s_seq        = 0;

const char* OffsetStateName(RuntimeOffsets::OffsetState s) {
    using OS = RuntimeOffsets::OffsetState;
    switch (s) {
        case OS::Pending:           return "Pending";
        case OS::ResolvedMatch:     return "Match";        // live == committed fallback (healthy)
        case OS::ResolvedShifted:   return "Shifted";      // live != fallback → STALE committed fallback to patch
        case OS::FallbackFieldName: return "FieldRenamed"; // class found, field name miss (BeeByte renamed)
        case OS::FallbackGaveUp:    return "ClassGaveUp";  // class never resolved (renamed) → needs recovery
        case OS::Suspect:           return "Suspect";      // live value failed a sanity check
    }
    return "Unknown";
}

// Full live offset audit: every registry entry with its committed fallback, the
// LIVE resolved offset, and a state — so the daily scan can auto-patch stale
// fallbacks (Shifted) and flag renamed classes/fields. Writes report.json
// (too big for the resp slot). Returns the row count, or -1 on failure.
int WriteReport(const char* dir) {
    char path[MAX_PATH], tmp[MAX_PATH];
    snprintf(path, sizeof(path), "%s\\report.json", dir);
    snprintf(tmp,  sizeof(tmp),  "%s\\report.json.tmp", dir);

    RuntimeOffsets::OffsetReportRow rows[256];
    const int total = RuntimeOffsets::GetOffsetReport(rows, 256);
    const int n = total < 256 ? total : 256;

    FILE* f = nullptr;
    if (fopen_s(&f, tmp, "wb") != 0 || !f) return -1;
    int match = 0, shifted = 0, renamed = 0, gaveup = 0, suspect = 0, pending = 0;
    fprintf(f, "{\n  \"entries\": [\n");
    for (int i = 0; i < n; ++i) {
        using OS = RuntimeOffsets::OffsetState;
        switch (rows[i].state) {
            case OS::ResolvedMatch:     ++match;   break;
            case OS::ResolvedShifted:   ++shifted; break;
            case OS::FallbackFieldName: ++renamed; break;
            case OS::FallbackGaveUp:    ++gaveup;  break;
            case OS::Suspect:           ++suspect; break;
            default:                    ++pending; break;
        }
        fprintf(f, "    { \"class\": \"%s\", \"field\": \"%s\", \"fallback\": \"0x%X\", \"live\": \"0x%X\", \"state\": \"%s\" }%s\n",
            rows[i].className ? rows[i].className : "?",
            rows[i].fieldName ? rows[i].fieldName : "?",
            rows[i].fallback, rows[i].value, OffsetStateName(rows[i].state),
            (i + 1 < n) ? "," : "");
    }
    fprintf(f, "  ],\n  \"summary\": { \"total\": %d, \"match\": %d, \"shifted\": %d, "
               "\"fieldRenamed\": %d, \"classGaveUp\": %d, \"suspect\": %d, \"pending\": %d }\n}\n",
            n, match, shifted, renamed, gaveup, suspect, pending);
    fclose(f);
    MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING);
    return n;
}

// Live method RVAs for a class (the "method offsets"): name + RVA = methodPointer
// - GameAssembly base. Writes methods.json. Returns method count, or -1 if the
// class isn't found.
int WriteClassMethods(const char* dir, const char* className) {
    Il2CppClass* k = (className && className[0]) ? Resolver::FindClassLoose(className) : nullptr;
    if (!k) return -1;
    const uintptr_t base = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"GameAssembly.dll"));

    char path[MAX_PATH], tmp[MAX_PATH];
    snprintf(path, sizeof(path), "%s\\methods.json", dir);
    snprintf(tmp,  sizeof(tmp),  "%s\\methods.json.tmp", dir);
    FILE* f = nullptr;
    if (fopen_s(&f, tmp, "wb") != 0 || !f) return -1;
    fprintf(f, "{\n  \"class\": \"%s\",\n  \"methods\": [\n", className);
    void* iter = nullptr;
    int count = 0;
    for (const MethodInfo* mi; (mi = il2cpp_class_get_methods(k, &iter)) != nullptr; ) {
        const char* name = il2cpp_method_get_name(mi);
        const uintptr_t ptr = reinterpret_cast<uintptr_t>(mi->methodPointer);
        const uintptr_t rva = (ptr && base && ptr > base) ? (ptr - base) : 0;
        fprintf(f, "%s    { \"name\": \"%s\", \"rva\": \"0x%llX\" }",
            count ? ",\n" : "", name ? name : "?",
            static_cast<unsigned long long>(rva));
        ++count;
    }
    fprintf(f, "\n  ],\n  \"count\": %d\n}\n", count);
    fclose(f);
    MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING);
    return count;
}

// Execute one pending command and write resp.json. Runs the REAL live il2cpp
// queries — this is what lets an external agent / the daily scan read live offsets
// and method RVAs while the game runs.
void PollCommand(const char* dir) {
    char cmdPath[MAX_PATH], respPath[MAX_PATH];
    snprintf(cmdPath,  sizeof(cmdPath),  "%s\\cmd.json",  dir);
    snprintf(respPath, sizeof(respPath), "%s\\resp.json", dir);

    char in[512];
    if (ReadFileSmall(cmdPath, in, sizeof(in)) <= 0) return;
    long long id = 0;
    if (!JsonInt(in, "id", id) || id == s_lastCmdId) return;   // nothing new
    s_lastCmdId = id;

    char cmd[64] = {}, arg[256] = {};
    JsonStr(in, "cmd", cmd, sizeof(cmd));
    JsonStr(in, "arg", arg, sizeof(arg));

    char result[512] = {};
    bool ok = true;
    if (strcmp(cmd, "resolve_class") == 0) {
        Il2CppClass* k = arg[0] ? Resolver::FindClassLoose(arg) : nullptr;
        snprintf(result, sizeof(result), "%s", k ? "found" : "not found");
        ok = (k != nullptr);
    } else if (strcmp(cmd, "field_offset") == 0) {
        char cls[128] = {}, fld[128] = {};
        const char* dot = strrchr(arg, '.');
        if (dot) {
            int cl = static_cast<int>(dot - arg);
            if (cl > 127) cl = 127;
            memcpy(cls, arg, static_cast<size_t>(cl)); cls[cl] = 0;
            snprintf(fld, sizeof(fld), "%s", dot + 1);
        }
        Il2CppClass* k = cls[0] ? Resolver::FindClassLoose(cls) : nullptr;
        FieldInfo* fi  = (k && fld[0]) ? il2cpp_class_get_field_from_name(k, fld) : nullptr;
        if (fi) snprintf(result, sizeof(result), "0x%X", static_cast<unsigned>(il2cpp_field_get_offset(fi)));
        else  { snprintf(result, sizeof(result), "unresolved"); ok = false; }
    } else if (strcmp(cmd, "dump_report") == 0) {
        const int n = WriteReport(dir);
        if (n >= 0) snprintf(result, sizeof(result), "wrote %d entries to report.json", n);
        else      { snprintf(result, sizeof(result), "failed to write report.json"); ok = false; }
    } else if (strcmp(cmd, "class_methods") == 0) {
        const int n = WriteClassMethods(dir, arg);
        if (n >= 0) snprintf(result, sizeof(result), "wrote %d methods to methods.json", n);
        else      { snprintf(result, sizeof(result), "class '%s' not found", arg); ok = false; }
    } else if (strcmp(cmd, "aoe_probe") == 0) {
        bool resolved = false; uint32_t oOff = 0, dOff = 0;
        AoeTracking::GetGjjProbe(resolved, oOff, dOff);
        snprintf(result, sizeof(result), "resolved=%s originOff=0x%X destOff=0x%X (trigger a Medusa AoE if unresolved)",
            resolved ? "true" : "false", oOff, dOff);
        ok = resolved;
    } else {
        snprintf(result, sizeof(result), "unknown cmd '%s'", cmd);
        ok = false;
    }

    char resp[768];
    const int rl = snprintf(resp, sizeof(resp),
        "{ \"id\": %lld, \"ok\": %s, \"result\": \"%s\" }\n",
        id, ok ? "true" : "false", result);
    if (rl > 0) AtomicWrite(respPath, resp, rl);
    DBG_FILE_LOG("[DiagBridge] cmd '" << cmd << "' arg='" << arg << "' -> " << result);
}

void WriteSnapshot(const char* dir) {
    char path[MAX_PATH];
    snprintf(path, sizeof(path), "%s\\diag.json", dir);

    const BootGate::State st = BootGate::Current();
    int healthy = 0, total = 0;
    BootGate::GetProgress(healthy, total);

    const bool inWorld = LocalPlayer::GetPtr() != nullptr;

    char buf[4096];
    int len = snprintf(buf, sizeof(buf),
        "{\n"
        "  \"seq\": %llu,\n"
        "  \"bootgate\": { \"state\": \"%s\", \"degraded\": %s, \"healthy\": %d, \"total\": %d, \"status\": \"%s\" },\n"
        "  \"player\": { \"inWorld\": %s, \"hp\": %d, \"maxHp\": %d, \"defense\": %d, \"x\": %.2f, \"y\": %.2f },\n"
        "  \"anchors\": [",
        static_cast<unsigned long long>(++s_seq),
        StateName(st),
        BootGate::Degraded() ? "true" : "false",
        healthy, total,
        BootGate::StatusLine(),
        inWorld ? "true" : "false",
        LocalPlayer::GetHP(), LocalPlayer::GetMaxHP(), LocalPlayer::GetDefense(),
        LocalPlayer::GetX(), LocalPlayer::GetY());

    BootGate::AnchorView anchors[16];
    const int na  = BootGate::GetAnchorReport(anchors, 16);
    const int cnt = na < 16 ? na : 16;
    for (int i = 0; i < cnt && len > 0 && len < static_cast<int>(sizeof(buf)) - 256; ++i) {
        len += snprintf(buf + len, sizeof(buf) - len,
            "%s\n    { \"class\": \"%s\", \"role\": \"%s\", \"critical\": %s, \"stale\": %s }",
            i ? "," : "",
            anchors[i].klass, anchors[i].role,
            anchors[i].critical ? "true" : "false",
            anchors[i].stale ? "true" : "false");
    }
    if (len > 0 && len < static_cast<int>(sizeof(buf)) - 512)
        len += snprintf(buf + len, sizeof(buf) - len, "\n  ],\n");

    // ── dodge internals (v3) ─────────────────────────────────────────────────
    const RePP::DiagView dv = RePP::GetDiagView();
    if (len > 0 && len < static_cast<int>(sizeof(buf)) - 400)
        len += snprintf(buf + len, sizeof(buf) - len,
            "  \"dodge\": { \"enabled\": %s, \"status\": \"%s\", \"player\": { \"x\": %.2f, \"y\": %.2f },\n"
            "    \"selectedTarget\": %s, \"selX\": %.2f, \"selY\": %.2f,\n"
            "    \"lockTarget\": %s, \"lockX\": %.2f, \"lockY\": %.2f,\n"
            "    \"candidates\": %d, \"threats\": %d, \"blockers\": %d, \"tileSpeed\": %.2f }\n",
            dv.enabled ? "true" : "false", FrameStatusName(dv.status),
            dv.playerX, dv.playerY,
            dv.hasSelectedTarget ? "true" : "false", dv.selX, dv.selY,
            dv.hasLockTarget ? "true" : "false", dv.lockX, dv.lockY,
            dv.candidateCount, dv.threatCount, dv.blockerCount, dv.tileSpeedAtPlayer);

    // ── PJDodge internals ────────────────────────────────────────────────────
    const PJDodge::DiagView pv = PJDodge::GetDiagView();
    if (len > 0 && len < static_cast<int>(sizeof(buf)) - 600)
        len += snprintf(buf + len, sizeof(buf) - len,
            "  ,\"pjdodge\": { \"enabled\": %s, \"decision\": %d, \"override\": %s,\n"
            "    \"player\": { \"x\": %.2f, \"y\": %.2f }, \"velPerSec\": { \"x\": %.2f, \"y\": %.2f },\n"
            "    \"candidate\": %d, \"speedScale\": %.2f, \"threats\": %d, \"impactMs\": %.0f,\n"
            "    \"projectiles\": %d, \"aoes\": %d, \"enemies\": %d,\n"
            "    \"prediction\": { \"enabled\": %s, \"calibrated\": %d, \"clockErrMs\": %.2f,\n"
            "      \"modelErrTiles\": %.4f, \"modelMaxTiles\": %.4f } }\n",
            pv.enabled ? "true" : "false", pv.decision,
            pv.overrideActive ? "true" : "false",
            pv.playerX, pv.playerY, pv.velXPerSec, pv.velYPerSec,
            pv.candidate, pv.speedScale, pv.threatCount, pv.earliestImpactMs,
            pv.projectiles, pv.aoes, pv.enemies,
            pv.predEnabled ? "true" : "false", pv.predCalibrated, pv.predClockErrMs,
            pv.predModelErrTiles, pv.predModelMaxTiles);

    // ── UDodge internals ─────────────────────────────────────────────────────
    const UDodge::DiagView uv = UDodge::GetDiagView();
    if (len > 0 && len < static_cast<int>(sizeof(buf)) - 700)
        len += snprintf(buf + len, sizeof(buf) - len,
            "  ,\"udodge\": { \"enabled\": %s, \"decision\": %d, \"override\": %s,\n"
            "    \"player\": { \"x\": %.2f, \"y\": %.2f }, \"velPerSec\": { \"x\": %.2f, \"y\": %.2f },\n"
            "    \"candidate\": %d, \"speedScale\": %.2f, \"threats\": %d, \"clearanceTiles\": %.3f,\n"
            "    \"lanes\": %d, \"zones\": %d, \"enemies\": %d,\n"
            "    \"tick\": { \"id\": %u, \"valid\": %s },\n"
            "    \"fieldActive\": %s,\n"
            "    \"lock\": { \"active\": %s, \"x\": %.2f, \"y\": %.2f } }\n",
            uv.enabled ? "true" : "false", uv.decision,
            uv.overrideActive ? "true" : "false",
            uv.playerX, uv.playerY, uv.velXPerSec, uv.velYPerSec,
            uv.candidate, uv.speedScale, uv.threatCount, uv.standClearanceTiles,
            uv.lanes, uv.zones, uv.enemies,
            uv.tickId, uv.tickValid ? "true" : "false",
            uv.fieldActive ? "true" : "false",
            uv.hasLockTarget ? "true" : "false", uv.lockX, uv.lockY);

    if (len > 0 && len < static_cast<int>(sizeof(buf)) - 8)
        len += snprintf(buf + len, sizeof(buf) - len, "}\n");

    if (len > 0) AtomicWrite(path, buf, len);
}

} // namespace

void Tick() {
    // Runtime opt-in (Test tab → settings.bEnableDiagBridge). Off by default, so a
    // normal user never touches %LOCALAPPDATA%\RealmEngine\*.json. The diag code is
    // always compiled in — this gate just keeps it dormant until a dev enables it.
    static bool s_prevEnabled = false;
    if (!settings.bEnableDiagBridge) {
        if (s_prevEnabled) {
            // Just toggled off: remove stale files so the MCP server doesn't read a
            // frozen snapshot as if the game were still live.
            const char* d = DiagDir();
            if (d) {
                char p[MAX_PATH];
                for (const char* fn : { "diag.json", "cmd.json", "resp.json" }) {
                    snprintf(p, sizeof(p), "%s\\%s", d, fn);
                    DeleteFileA(p);
                }
            }
            s_lastSnapMs = 0;   // re-enabling writes a fresh snapshot immediately
            s_lastCmdMs  = 0;
            s_prevEnabled = false;
        }
        return;
    }
    s_prevEnabled = true;

    const char* dir = DiagDir();
    if (!dir) return;
    const ULONGLONG now = GetTickCount64();

    // Commands are polled more often than the snapshot is written, so on-demand
    // queries (resolve_class / field_offset) answer within ~200ms.
    if (s_lastCmdMs == 0 || now - s_lastCmdMs >= 200) {
        s_lastCmdMs = now;
        PollCommand(dir);
    }

    if (s_lastSnapMs != 0 && now - s_lastSnapMs < 1000) return;   // ~1 Hz snapshot
    s_lastSnapMs = now;
    WriteSnapshot(dir);

    // Once boot settles, write the full offset audit ONCE so a headless consumer
    // (the beebyte daily scan on the smoke VM) can scp report.json next to the trace
    // — no interactive command needed.
    static bool s_reportWritten = false;
    if (!s_reportWritten && BootGate::Current() == BootGate::State::Ready) {
        WriteReport(dir);
        s_reportWritten = true;
    }
}

} // namespace DiagBridge
