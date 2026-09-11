#include "pch-il2cpp.h"
#include "CosmeticOverrides.h"

#include "DbgFileLog.h"
#include "FeatureState.h"
#include "GameState.h"
#include "Il2CppHook.h"
#include "Il2CppResolver.h"
#include "RuntimeOffsets.h"
#include "core/il2cpp/Il2CppContainers.h"
#include "core/runtime/MemRead.h"

#include <Windows.h>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <vector>

namespace {

// ── Symbols (Dump 6.13.0.1.0 — see internal/refs/Dump) ───────────────────────
// BeeByte renames the gameplay classes but leaves the UI MonoBehaviours alone.
constexpr const char* kPlayerClass       = "FKALGHJIADI";   // DecaGames.RotMG.Objects.Map.Player
constexpr const char* kEntranceMgrClass  = "GFHKBNHBPLE";   // EntrancesManager
constexpr const char* kPetClass          = "AAGOIIEJOMO";   // Pet

// Player::BFAGHBNLKEP(string name, int32 prefix, int32 suffix, JGPFJPNAEKA type)
// is the nameplate builder MapViewService drives out of NEWTICK, so it is the
// only place a title can be shown without touching the wire.
constexpr const char* kSetTitleMethod    = "BFAGHBNLKEP";
constexpr const char* kGetNameMethod     = "get_Name";
// EntrancesManager::AFCFJHAMLPE(Player target, int32 entranceType) plays the
// effect from its argument — it never reads the manager's own selection field.
constexpr const char* kPlayEntranceMethod = "AFCFJHAMLPE";
// Pet::HDKBNHKLEAO(int32 skinType) swaps the pet's ObjectProperties. The pet's
// objectType and the PetType stat both sit below this and do not drive the sprite.
constexpr const char* kSetPetSkinMethod  = "HDKBNHKLEAO";
// Pet.KJNHLADHEMH — the skin type HDKBNHKLEAO writes first. Read back to detect
// the game reverting us. Offset comes from disassembled accesses, so it is
// already a runtime offset and takes no ACTK shift.
constexpr uint32_t kPetSkinTypeOffset = 0x380;
// Pet.IHOBGMGJGGO — the flag the draw path checks alongside the drawn slot.
constexpr uint32_t kPetSkinActiveOffset = 0x384;
// Pet.EJFEMLJBKDE — the ObjectProperties the per-frame draw (LPGNNFPFAGD) reads.
// Observed identical across two different skin ids, so the setter resolves the
// skin but never promotes it here; the account does not own the skin.
constexpr uint32_t kPetDrawPropsOffset = 0x388;
// Pet.HLCDOFDKNCJ — where the setter stages the resolved skin properties.
// Observed changing with every skin id, so this is the value to promote.
constexpr uint32_t kPetSkinPropsOffset = 0x390;

constexpr const char* kCharacterInfoNs   = "DecaGames.RotMG.UI.GUI";
constexpr const char* kCharacterInfoName = "CharacterInfo";
constexpr const char* kLoadCharacterIcon = "LoadCharacterIcon";
constexpr uint32_t    kCharacterIconLoaderOffset = 0x48;  // CharacterInfo.characterIconLoader

// JGPFJPNAEKA { PlainText = 1, TextWithIcon = 2 }. Real titles carry an icon.
constexpr int32_t kTitleTextWithIcon = 2;

// Player.NJEBOLMLOLA is the player's own Pet reference — far more reliable than
// scanning the world dictionary and guessing which pet is ours. Reference fields
// on Player are not ACTK-shifted (same as PlayerEquipMgr), but the +0x50 variant
// is probed as a fallback and both are validated against the Pet class.
constexpr uint32_t kPlayerPetOffsets[] = { 0x5C8, 0x5C8 + 0x50 };

constexpr ULONGLONG kResolveRetryMs = 2000ULL;
constexpr ULONGLONG kDiagIntervalMs = 5000ULL;

// ── Cached IL2CPP handles ────────────────────────────────────────────────────
const MethodInfo* s_miSetTitle     = nullptr;
const MethodInfo* s_miGetName      = nullptr;
const MethodInfo* s_miPlayEntrance = nullptr;
const MethodInfo* s_miSetPetSkin   = nullptr;
const MethodInfo* s_miLoadIcon     = nullptr;
Il2CppClass*      s_petClass       = nullptr;
Il2CppClass*      s_charInfoClass  = nullptr;
ULONGLONG         s_lastResolveMs  = 0;

// ── Applied-state tracking ───────────────────────────────────────────────────
// The title is composed from the player's name, and the game writes the result
// back over the very field the name is read from. Re-reading it each frame
// therefore feeds the composed name back in and the title stacks onto itself
// without bound. The un-titled name is captured once and reused instead.
bool      s_titleApplied      = false;
char      s_titleBaseName[128]  = {};
char      s_titleComposed[256]  = {};
void*     s_titleLastPlayer     = nullptr;
ULONGLONG s_titleNextApplyMs    = 0;

void      ResetTitleState()
{
    s_titleApplied       = false;
    s_titleBaseName[0]   = '\0';
    s_titleComposed[0]   = '\0';
    s_titleLastPlayer    = nullptr;
    s_titleNextApplyMs   = 0;
}

void*     s_entranceLastPlayer = nullptr;
int       s_entranceLastId     = -1;

void*     s_petLastPtr      = nullptr;
int       s_petLastId       = -1;
ULONGLONG s_petNextApplyMs  = 0;

void*                   s_charInfo = nullptr;
std::atomic<bool>       s_iconRefreshRequested{ false };

uint32_t s_entranceMgrFieldOffset = 0;

// EntrancesManager is a plain object, not a MonoBehaviour, so the Unity scene
// scan cannot see it — it is only reachable through the single ApplicationManager
// field of that type. Matching on type rather than name survives re-obfuscation.
void* ResolveEntranceManager(void* appManager)
{
    Il2CppClass* mgrClass = Resolver::FindClassLoose(kEntranceMgrClass);
    if (!mgrClass || !Mem::AddrOk(appManager)) return nullptr;

    if (s_entranceMgrFieldOffset == 0) {
        Il2CppClass* appClass = nullptr;
        if (!Resolver::Protection::safe_call([&]() {
                appClass = il2cpp_object_get_class(reinterpret_cast<Il2CppObject*>(appManager));
            }) || !appClass)
            return nullptr;

        FieldInfo* match = nullptr;
        int matches = 0;
        void* iter = nullptr;
        while (FieldInfo* field = il2cpp_class_get_fields(appClass, &iter)) {
            if (il2cpp_field_is_literal(field) || (il2cpp_field_get_flags(field) & 0x0010)) continue;
            const Il2CppType* type = il2cpp_field_get_type(field);
            if (type && il2cpp_class_from_type(type) == mgrClass) {
                match = field;
                ++matches;
            }
        }
        if (matches != 1 || !match) return nullptr;
        s_entranceMgrFieldOffset = static_cast<uint32_t>(il2cpp_field_get_offset(match));
        DBG_FILE_LOG("[CosmeticOverrides] EntrancesManager field at 0x"
            << std::hex << s_entranceMgrFieldOffset << std::dec);
    }

    return Mem::ReadPtr(appManager, s_entranceMgrFieldOffset);
}

// ─────────────────────────────────────────────────────────────────────────────

// Resolution is retried on an interval because the UI classes only exist once
// the game has built its canvas, which is well after the DLL attaches.
void ResolveHandles()
{
    const ULONGLONG now = GetTickCount64();
    if (s_lastResolveMs != 0 && now - s_lastResolveMs < kResolveRetryMs) return;
    s_lastResolveMs = now;

    if (!s_miSetTitle)
        s_miSetTitle = Il2CppHook::ResolveMethodCached(kPlayerClass, kSetTitleMethod, 4);
    if (!s_miGetName)
        s_miGetName = Il2CppHook::ResolveMethodCached(kPlayerClass, kGetNameMethod, 0);
    if (!s_miPlayEntrance)
        s_miPlayEntrance = Il2CppHook::ResolveMethodCached(kEntranceMgrClass, kPlayEntranceMethod, 2);
    // BeeByte renames Pet to AAGOIIEJOMO, but fall back to the plain name so a
    // rename in a future build degrades to "pet override off", not a wrong call.
    if (!s_miSetPetSkin) {
        s_miSetPetSkin = Il2CppHook::ResolveMethodCached(kPetClass, kSetPetSkinMethod, 1);
        if (!s_miSetPetSkin)
            s_miSetPetSkin = Il2CppHook::ResolveMethodCached("Pet", kSetPetSkinMethod, 1);
    }
    if (!s_petClass) {
        s_petClass = Resolver::FindClassLoose(kPetClass);
        if (!s_petClass) s_petClass = Resolver::FindClassLoose("Pet");
    }
    if (!s_charInfoClass)
        s_charInfoClass = Resolver::FindClass(kCharacterInfoNs, kCharacterInfoName);
    if (!s_miLoadIcon && s_charInfoClass) {
        Il2CppClass* loaderClass = Resolver::FindClass("DecaGames.RotMG.UI.Helpers", "UIIconLoader");
        if (loaderClass)
            s_miLoadIcon = il2cpp_class_get_method_from_name(loaderClass, kLoadCharacterIcon, 1);
    }
}

// ── Titles ───────────────────────────────────────────────────────────────────

void ApplyTitle(void* player)
{
    const bool enabled = FeatureState::GetTitleOverrideEnabled();
    const int  id      = FeatureState::GetTitleOverrideId();

    if (!enabled || id <= 0 || !player || !s_miSetTitle) {
        // Nothing to undo: the game recomputes the nameplate from the server's
        // own stats, which is exactly the un-overridden state.
        ResetTitleState();
        return;
    }

    if (player != s_titleLastPlayer) {
        ResetTitleState();
        s_titleLastPlayer = player;
    }

    // What the nameplate currently reads. This is also where the composed result
    // lands, which is why it can never be used as the name to compose *from*
    // more than once.
    char live[256] = {};
    void* livePtr = Mem::ReadPtr(player, RuntimeOffsets::PlayerIGN);
    if (Mem::AddrOk(livePtr)) Il2CppC::ReadStringUtf8(livePtr, live, sizeof(live));
    if (live[0] == '\0') return;

    // Already showing our title — leave it alone.
    if (s_titleComposed[0] != '\0' && strcmp(live, s_titleComposed) == 0) return;

    // The name is not ours, so the game has just rebuilt the nameplate from the
    // server's stats: whatever is there now is the clean, un-titled name.
    strncpy_s(s_titleBaseName, live, _TRUNCATE);

    // A wrong readback would otherwise invoke every frame; cap the rate so the
    // worst case is a few calls a second rather than one per frame.
    const ULONGLONG now = GetTickCount64();
    if (now < s_titleNextApplyMs) return;
    s_titleNextApplyMs = now + 100ULL;

    Il2CppObject* name = reinterpret_cast<Il2CppObject*>(il2cpp_string_new(s_titleBaseName));
    if (!Mem::AddrOk(name)) return;

    // objects.xml splits titles into Prefix / Suffix / Full, but the game call
    // only carries a prefix and a suffix id. Full titles lead the name, so they
    // ride in the prefix argument.
    const int slot   = FeatureState::GetTitleOverrideSlot();
    int32_t   prefix = (slot == 1) ? 0 : id;
    int32_t   suffix = (slot == 1) ? id : 0;
    int32_t   mode   = kTitleTextWithIcon;

    Il2CppObject* self = reinterpret_cast<Il2CppObject*>(player);
    void* params[4] = { name, &prefix, &suffix, &mode };
    Resolver::Protection::SafeRuntimeInvoke(s_miSetTitle, self, params);

    // Remember what the call produced so the next frame recognises it as ours.
    void* afterPtr = Mem::ReadPtr(player, RuntimeOffsets::PlayerIGN);
    if (Mem::AddrOk(afterPtr))
        Il2CppC::ReadStringUtf8(afterPtr, s_titleComposed, sizeof(s_titleComposed));

    if (!s_titleApplied) {
        s_titleApplied = true;
        DBG_FILE_LOG("[CosmeticOverrides] title override applied: id=" << id
            << " slot=" << slot << " base=" << s_titleBaseName);
    }
}

// ── Entrances ────────────────────────────────────────────────────────────────

void ApplyEntrance(void* player)
{
    const bool enabled = FeatureState::GetEntranceOverrideEnabled();
    const int  id      = FeatureState::GetEntranceOverrideId();

    if (!enabled || id <= 0 || !player || !s_miPlayEntrance) {
        s_entranceLastPlayer = nullptr;
        s_entranceLastId     = -1;
        return;
    }

    // The effect is a one-shot animation, so it fires on world entry (new local
    // player pointer) or when a different entrance is picked — never per frame.
    if (player == s_entranceLastPlayer && id == s_entranceLastId) return;
    s_entranceLastPlayer = player;
    s_entranceLastId     = id;

    void* manager = ResolveEntranceManager(GameState::GetAppMgr());
    if (!Mem::AddrOk(manager)) return;

    int32_t entranceType = id;
    void*   params[2]    = { player, &entranceType };
    Resolver::Protection::SafeRuntimeInvoke(
        s_miPlayEntrance, reinterpret_cast<Il2CppObject*>(manager), params);
    DBG_FILE_LOG("[CosmeticOverrides] entrance effect played: id=" << id);
}

// ── Pet skins ────────────────────────────────────────────────────────────────

// The player's own Pet reference, validated by class so a wrong offset reads as
// "no pet" instead of invoking a method on an unrelated object.
void* FindLocalPet(void* player)
{
    if (!s_petClass) return nullptr;
    for (uint32_t offset : kPlayerPetOffsets) {
        void* candidate = Mem::ReadPtr(player, offset);
        if (!Mem::AddrOk(candidate)) continue;
        Il2CppClass* klass = nullptr;
        if (!Resolver::Protection::safe_call([&]() {
                klass = il2cpp_object_get_class(reinterpret_cast<Il2CppObject*>(candidate));
            }))
            continue;
        if (klass == s_petClass) return candidate;
    }
    return nullptr;
}

void ApplyPetSkin(void* player)
{
    const bool enabled = FeatureState::GetPetSkinOverrideEnabled();
    const int  id      = FeatureState::GetPetSkinOverrideId();

    if (!enabled || id <= 0 || !player || !s_miSetPetSkin) {
        s_petLastPtr = nullptr;
        s_petLastId  = -1;
        return;
    }

    void* pet = FindLocalPet(player);
    if (!pet) return;

    // Two separate things have to hold: the setter must have resolved the skin,
    // and the resolved properties must be sitting in the slot the draw actually
    // reads. The setter only ever does the first for a skin the account owns.
    int32_t liveSkin  = 0;
    void*   drawProps = Mem::ReadPtr(pet, kPetDrawPropsOffset);
    void*   skinProps = Mem::ReadPtr(pet, kPetSkinPropsOffset);

    const bool skinSet  = Mem::TryRead(pet, kPetSkinTypeOffset, liveSkin) && liveSkin == id;
    const bool promoted = Mem::AddrOk(skinProps) && drawProps == skinProps;
    if (skinSet && promoted) {
        s_petLastPtr = pet;
        s_petLastId  = id;
        return;
    }

    // While the pet is still loading, its own draw path keeps resetting the skin
    // to -1, so a slow retry loses that fight for as long as loading takes. Retry
    // close to per-frame; the readback above stops the calls the moment it sticks.
    const ULONGLONG now = GetTickCount64();
    if (now < s_petNextApplyMs) return;
    s_petNextApplyMs = now + 16ULL;

    const bool firstApply = (pet != s_petLastPtr || id != s_petLastId);
    s_petLastPtr = pet;
    s_petLastId  = id;

    if (!skinSet) {
        int32_t skinType = id;
        void*   params[1] = { &skinType };
        Resolver::Protection::SafeRuntimeInvoke(
            s_miSetPetSkin, reinterpret_cast<Il2CppObject*>(pet), params);
        skinProps = Mem::ReadPtr(pet, kPetSkinPropsOffset);
    }

    // Promote the staged skin into the drawn slot. This is the step the game
    // withholds for an unowned skin, and it is what makes the sprite change.
    if (Mem::AddrOk(skinProps)) {
        Mem::TryWrite<void*>(pet, kPetDrawPropsOffset, skinProps);
        Mem::TryWrite<uint8_t>(pet, kPetSkinActiveOffset, 1);
    }

    if (firstApply)
        DBG_FILE_LOG("[CosmeticOverrides] pet skin applied: id=" << id);
}

// ── HUD portrait ─────────────────────────────────────────────────────────────

void RefreshCharacterIcon(void* player)
{
    if (!s_iconRefreshRequested.exchange(false, std::memory_order_relaxed)) return;
    if (!player || !s_miLoadIcon || !s_charInfoClass) return;

    if (!Mem::AddrOk(s_charInfo) ||
        !Resolver::Protection::IsAlive(reinterpret_cast<Il2CppObject*>(s_charInfo))) {
        std::vector<Il2CppObject*> found = Resolver::FindObjectsByType(s_charInfoClass);
        s_charInfo = found.empty() ? nullptr : found[0];
    }
    if (!Mem::AddrOk(s_charInfo)) return;

    void* loader = Mem::ReadPtr(s_charInfo, kCharacterIconLoaderOffset);
    if (!Mem::AddrOk(loader)) return;

    void* params[1] = { player };
    Resolver::Protection::SafeRuntimeInvoke(
        s_miLoadIcon, reinterpret_cast<Il2CppObject*>(loader), params);
}

// ── Diagnostics ──────────────────────────────────────────────────────────────
// Deliberately written through the ungated writer rather than DBG_FILE_LOG:
// chatty tracing is compiled off in Release, and these overrides can only be
// diagnosed against the real game. Emits nothing until an override is switched
// on, then at most one line every few seconds.
void LogStatus(void* player)
{
    if (!FeatureState::GetTitleOverrideEnabled() &&
        !FeatureState::GetPetSkinOverrideEnabled() &&
        !FeatureState::GetEntranceOverrideEnabled())
        return;

    static ULONGLONG s_nextMs = 0;
    const ULONGLONG now = GetTickCount64();
    if (now < s_nextMs) return;
    s_nextMs = now + kDiagIntervalMs;

    // liveSkin is the value the pet actually holds: equal to the id means the
    // write landed and stuck, anything else means the game reverted it.
    void*   pet      = player ? FindLocalPet(player) : nullptr;
    int32_t liveSkin = -1;
    // The three ObjectProperties the skin setter fills in. BJCALADGJAG draws from
    // HLCDOFDKNCJ, so if that stays null the setter's lookup never resolved and
    // the id domain is wrong rather than the write being reverted.
    void* props0 = nullptr; void* props1 = nullptr; void* props2 = nullptr;
    if (pet) {
        Mem::TryRead(pet, kPetSkinTypeOffset, liveSkin);
        props0 = Mem::ReadPtr(pet, 0x388);
        props1 = Mem::ReadPtr(pet, 0x390);
        props2 = Mem::ReadPtr(pet, 0x398);
    }

    char line[768];
    snprintf(line, sizeof(line),
        "[CosmeticOverrides] player=%p | title(on=%d id=%d slot=%d mi=%d applied=%d "
        "base='%s' composed='%s') | pet(on=%d id=%d mi=%d cls=%d ptr=%p live=%d "
        "props=%p/%p/%p) | entrance(on=%d id=%d mi=%d fld=0x%X)",
        player,
        FeatureState::GetTitleOverrideEnabled() ? 1 : 0,
        FeatureState::GetTitleOverrideId(),
        FeatureState::GetTitleOverrideSlot(),
        s_miSetTitle ? 1 : 0,
        s_titleApplied ? 1 : 0,
        s_titleBaseName,
        s_titleComposed,
        FeatureState::GetPetSkinOverrideEnabled() ? 1 : 0,
        FeatureState::GetPetSkinOverrideId(),
        s_miSetPetSkin ? 1 : 0,
        s_petClass ? 1 : 0,
        pet,
        liveSkin,
        props0, props1, props2,
        FeatureState::GetEntranceOverrideEnabled() ? 1 : 0,
        FeatureState::GetEntranceOverrideId(),
        s_miPlayEntrance ? 1 : 0,
        s_entranceMgrFieldOffset);
    DbgFileLogWrite(line);
}

} // namespace

void CosmeticOverrides::RequestCharacterIconRefresh()
{
    s_iconRefreshRequested.store(true, std::memory_order_relaxed);
}

void CosmeticOverrides::Tick()
{
    ResolveHandles();

    void* player = GameState::GetLocalPtr();
    if (!Mem::AddrOk(player)) {
        // Dropping the cached pointers makes the next world entry re-apply
        // everything, including the one-shot entrance effect.
        s_entranceLastPlayer = nullptr;
        s_petLastPtr         = nullptr;
        return;
    }

    ApplyTitle(player);
    ApplyEntrance(player);
    ApplyPetSkin(player);
    RefreshCharacterIcon(player);
    LogStatus(player);
}
