#pragma once
// UDodgeMapDiag — Item 3 observability (navigation finish plan, 2026-09-19).
//
// WHY: docs/navigation/2026-09-15-global-routing-integration.md documents a
// fail-closed limitation in the D* global router's map capture — after a map
// epoch change, if the game reuses both the WorldMgr and its tile-list
// pointers with an equal-or-larger count, the old pointer/size-only readiness
// test can never prove the list was replaced, so capture stays map_pending
// forever. The owner's real session confirmed it: with navNavigator=dstar,
// [Diag/Nav] showed map_pending=1 on 17 of 17 walk-to lines — the persistent
// router contributed nothing all session, silently.
//
// Runtime.cpp (Movement::Nav::Runtime::Capture) now fills a CaptureDiag every
// tick as plain data — a guard enum, a square count, the live list pointer
// and count, and how long this epoch has been pending — whether or not
// anyone is watching. That is a handful of field copies, not a string format
// or a file write, so it costs nothing when diagnostics are off. This header
// is the part that actually costs something (snprintf + DbgFileLogWrite), and
// it is only ever called from inside UDodge::Tick's existing `if (diagOn)`
// block — the same gate every other [Diag/*] line already rides.
//
// Line shape:
//   pending (throttled to once per kPendingLogPeriodMs, plus once immediately
//     on entering pending): which guard is holding capture, how many squares
//     have been read this epoch, the live list pointer/count, and how long
//     this epoch has been pending.
//   ready (once, on the pending -> ready transition): the same facts, plus
//     whether it resolved via the pre-existing pointer/shrink evidence
//     (fast_path=1) or the new own-tile+ring proof (fast_path=0).
#include "features/movement/nav/Router.h"

#include <cstdint>
#include <cstdio>

namespace UDodge { namespace MapDiag {

using Sink = void (*)(const char* line);

inline const char* GuardName(Movement::Nav::CaptureGuard g)
{
    switch (g) {
        case Movement::Nav::CaptureGuard::None:                return "none";
        case Movement::Nav::CaptureGuard::NoMapInfo:           return "no_map_info";
        case Movement::Nav::CaptureGuard::ListUnreadable:      return "list_unreadable";
        case Movement::Nav::CaptureGuard::AwaitingReplacement: return "awaiting_list_replacement";
    }
    return "?";
}

inline constexpr uint64_t kPendingLogPeriodMs = 3000;

struct State {
    bool seen = false;
    bool wasReady = false;
    uint64_t lastLogMs = 0;
};

// Call once a tick, only while diagOn (UDodge::Tick's existing gate) and the
// dstar navigator is selected. Pure aside from the sink call: no clock reads
// (nowMs is the caller's), no allocation.
inline void Step(State& st, const Movement::Nav::CaptureDiag& d, uint64_t nowMs, Sink sink)
{
    const bool justReady = d.ready && (!st.seen || !st.wasReady);
    const bool due = !d.ready && (!st.seen || nowMs - st.lastLogMs >= kPendingLogPeriodMs);
    if (justReady || due) {
        char line[256];
        std::snprintf(line, sizeof(line),
            "[Diag/Map] t=%llu epoch=%llu %s guard=%s squares=%d list=%p count=%d pending_ms=%llu fast_path=%d",
            static_cast<unsigned long long>(nowMs), static_cast<unsigned long long>(d.epoch),
            d.ready ? "ready" : "pending", GuardName(d.guard), d.squaresRead, d.listPtr, d.listSize,
            static_cast<unsigned long long>(d.pendingMs), d.fastPath ? 1 : 0);
        if (sink) sink(line);
        st.lastLogMs = nowMs;
    }
    st.seen = true;
    st.wasReady = d.ready;
}

} } // namespace UDodge::MapDiag
