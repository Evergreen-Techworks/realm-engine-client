#pragma once
// EnemyClassify — which world objects the enemy snapshot keeps, and why one is
// dropped. Pure: EnemyTracker reads the fields under SEH and passes plain values,
// so the host suite (internal/tests/enemy_tracker_tests.cpp) tests the rule itself.
//
// Every consumer of the snapshot inherits a drop made here: uDodge's blockers and
// its enemy lock, AutoAim's target pool and its locked target, KillAura, and
// auto-break-walls. Soft properties (invulnerable, health bar, scenery) are NOT
// reasons to drop; each consumer applies its own policy to those.
//
// There is deliberately no "maxHp == 200" rule. The tracker used to drop every
// object at 200 max HP as a "decoy". Player decoys are not enemies (objects.xml
// gives Class Decoy no <Enemy/> tag, so isEnemy already rejects them). The game
// initialises an entity's MaxHP and HP from ObjectProperties.MaxHitPointsElement,
// and to 200 when the element is absent. So that rule dropped two groups:
//   • 77 real enemy types authored at exactly 200 HP, among them the Hobbit Mage
//     and Elf Wizard Realm quests, Ent Saplings, Imps, Pythons and Den Spiders.
//     They were never locked, aimed at or dodged around. Now kept.
//   • objects with no <MaxHitPoints> still at that default: props, telegraphs,
//     turrets and invisible helpers. Still dropped, as DefaultHp.
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <vector>

namespace EnemyClassify {

enum class Reject : uint8_t {
    None = 0,      // kept
    Unreadable,    // entity or its ObjectProperties could not be read
    NotEnemy,      // ObjectProperties.isEnemy is false (players, pets, decoys, props)
    HiddenHelper,  // a type the client's game data marks as a hidden helper
    NoHealth,      // hp <= 0 or maxHp <= 0 (dead, or not a damageable object)
    HpAboveMax,    // hp > maxHp: an implausible read, not a live enemy
    DefaultHp,     // no authored MaxHitPoints and still at the game's 200 default
    IgnoredType,   // a type listed in kIgnoredTypes
    BadPosition,   // non-finite, or exactly (0,0) before the first position update
};

// MaxHP the game gives an object whose ObjectProperties has no MaxHitPoints.
inline constexpr int32_t kGameDefaultMaxHp = 200;

struct Facts {
    bool    isEnemy       = false;
    // The client's hidden-helper list names this type (see SetHiddenHelperTypes).
    bool    hiddenHelper  = false;
    // ObjectProperties.MaxHitPointsElement is non-null. True when it cannot be
    // read, so an unresolved offset never drops an authored enemy.
    bool    authoredMaxHp = true;
    int32_t objType       = 0;
    int32_t hp            = 0;
    int32_t maxHp         = 0;
    float   x             = 0.f;
    float   y             = 0.f;
};

// 0x6F4B "Snowball Stash Realm Spawner Undead Forest" — an <Enemy/> controller.
inline constexpr int32_t kIgnoredTypes[] = { 28491 };

inline bool IsIgnoredType(int32_t t)
{
    for (int32_t v : kIgnoredTypes) if (v == t) return true;
    return false;
}

// Checks run in the order EnemyTracker reads the fields, so the first failing
// read is the reason reported.
inline Reject Classify(const Facts& f)
{
    if (!f.isEnemy) return Reject::NotEnemy;
    if (f.hiddenHelper) return Reject::HiddenHelper;
    if (f.hp <= 0 || f.maxHp <= 0) return Reject::NoHealth;
    if (f.hp > f.maxHp) return Reject::HpAboveMax;
    if (!f.authoredMaxHp && f.maxHp == kGameDefaultMaxHp) return Reject::DefaultHp;
    if (IsIgnoredType(f.objType)) return Reject::IgnoredType;
    if (!std::isfinite(f.x) || !std::isfinite(f.y) || (f.x == 0.f && f.y == 0.f))
        return Reject::BadPosition;
    return Reject::None;
}

inline const char* Name(Reject r)
{
    switch (r) {
    case Reject::None:        return "kept";
    case Reject::Unreadable:  return "unreadable";
    case Reject::NotEnemy:    return "not-enemy";
    case Reject::HiddenHelper: return "hidden-helper";
    case Reject::NoHealth:    return "no-health";
    case Reject::HpAboveMax:  return "hp-above-max";
    case Reject::DefaultHp:   return "default-hp";
    case Reject::IgnoredType: return "ignored-type";
    case Reject::BadPosition: return "bad-position";
    }
    return "?";
}

// ── Type lists pushed by the client ──────────────────────────────────────────
// Parses object types separated by commas, semicolons or whitespace, each decimal
// or 0x-hex. `append` adds to `inOut`; otherwise the list replaces it. The result
// is sorted and unique. A token that is not a type in 0..65535 rejects the whole
// message and leaves `inOut` unchanged.
inline bool ParseTypeList(const char* text, std::vector<int32_t>& inOut, bool append)
{
    std::vector<int32_t> parsed;
    if (append) parsed = inOut;
    const char* p = text ? text : "";
    while (*p) {
        while (*p && (*p == ',' || *p == ';' || std::isspace(static_cast<unsigned char>(*p)))) ++p;
        if (!*p) break;
        const char* start = p;
        while (*p && *p != ',' && *p != ';' && !std::isspace(static_cast<unsigned char>(*p))) ++p;
        const bool hex = (p - start) > 2 && start[0] == '0' && (start[1] == 'x' || start[1] == 'X');
        const char* digits = hex ? start + 2 : start;
        if (digits == p) return false;
        long value = 0;
        for (const char* d = digits; d < p; ++d) {
            const unsigned char c = static_cast<unsigned char>(*d);
            int v;
            if (c >= '0' && c <= '9') v = c - '0';
            else if (hex && c >= 'a' && c <= 'f') v = 10 + (c - 'a');
            else if (hex && c >= 'A' && c <= 'F') v = 10 + (c - 'A');
            else return false;
            value = value * (hex ? 16 : 10) + v;
            if (value > 0xFFFF) return false;
        }
        parsed.push_back(static_cast<int32_t>(value));
    }
    std::sort(parsed.begin(), parsed.end());
    parsed.erase(std::unique(parsed.begin(), parsed.end()), parsed.end());
    inOut.swap(parsed);
    return true;
}

// One client message: "+<types>" appends (for lists longer than one feature
// command's 4096-byte value), anything else replaces; "" clears.
inline bool ApplyTypeListMessage(const char* message, std::vector<int32_t>& inOut)
{
    const char* m = message ? message : "";
    return m[0] == '+' ? ParseTypeList(m + 1, inOut, true) : ParseTypeList(m, inOut, false);
}

inline bool IsListed(const std::vector<int32_t>& sortedTypes, int32_t type)
{
    return std::binary_search(sortedTypes.begin(), sortedTypes.end(), type);
}

} // namespace EnemyClassify
