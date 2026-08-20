#include "pch-il2cpp.h"
#include "UDodgeWorker.h"
#include "UDodgePlanner.h"

#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>

// ─────────────────────────────────────────────────────────────────────────────
// IL2CPP-FREE ZONE. Nothing in this file — and nothing WorkerLoop reaches —
// may call il2cpp_*, read a game object, or dereference an Env function pointer.
// The worker thread races the GC if it touches live world memory (plan 55). It
// operates ONLY on the plain-data PlannerSnapshot (verified pure in plan 58) and
// writes a plain-data PlanResult. Planner::Compute is likewise pure math.
//
// The handoff mirrors the proven render-overlay publish (UDodge.cpp g_debugMutex):
// the game thread never blocks — it try_to_locks and drops the frame on
// contention. The worker may block only on its own CV wait and the brief lock
// hold during the memcpy-out.
// ─────────────────────────────────────────────────────────────────────────────

namespace UDodge { namespace Worker {
namespace {

std::thread              g_thread;
std::atomic<bool>        g_running{ false };   // guards double-start / late Stop
std::atomic<bool>        g_stop{ false };

// g_snapMutex guards the pending snapshot handed game → worker.
std::mutex               g_snapMutex;
std::condition_variable  g_snapCv;
Planner::PlannerSnapshot g_pendingSnap;
bool                     g_haveSnap = false;
uint32_t                 g_seq = 0;            // monotonic publish sequence

// g_planMutex guards the latest plan handed worker → game.
std::mutex               g_planMutex;
Planner::PlanResult      g_latestPlan;
bool                     g_havePlan = false;

void WorkerLoop()
{
    Planner::PlannerSnapshot local;   // worker-owned copy — never aliases game state
    for (;;) {
        {
            std::unique_lock<std::mutex> lk(g_snapMutex);
            g_snapCv.wait(lk, [] {
                return g_haveSnap || g_stop.load(std::memory_order_relaxed);
            });
            if (g_stop.load(std::memory_order_relaxed)) return;
            local = g_pendingSnap;     // copy out under lock, then release
            g_haveSnap = false;
        }
        // No lock held during compute. Pure plain-data math — no IL2CPP.
        Planner::PlanResult plan{};
        Planner::Compute(local, plan);
        {
            std::lock_guard<std::mutex> lk(g_planMutex);
            g_latestPlan = plan;
            g_havePlan = true;
        }
    }
}

} // namespace

void Start()
{
    bool expected = false;
    if (!g_running.compare_exchange_strong(expected, true))
        return;   // already running — idempotent
    g_stop.store(false, std::memory_order_relaxed);
    { std::lock_guard<std::mutex> lk(g_snapMutex); g_haveSnap = false; }
    { std::lock_guard<std::mutex> lk(g_planMutex); g_havePlan = false; }
    g_thread = std::thread(WorkerLoop);
}

void Stop()
{
    if (!g_running.load(std::memory_order_relaxed))
        return;   // never started (or already stopped) — idempotent
    {
        std::lock_guard<std::mutex> lk(g_snapMutex);
        g_stop.store(true, std::memory_order_relaxed);
    }
    g_snapCv.notify_one();
    if (g_thread.joinable())
        g_thread.join();   // JOIN before returning — no detached thread survives
    g_running.store(false, std::memory_order_relaxed);
}

uint32_t PublishSnapshot(const Planner::PlannerSnapshot& snap)
{
    std::unique_lock<std::mutex> lk(g_snapMutex, std::try_to_lock);
    if (!lk.owns_lock())
        return 0;   // contention → drop this frame's publish; NEVER block the game thread
    g_pendingSnap = snap;
    const uint32_t seq = g_pendingSnap.seq = ++g_seq;
    g_haveSnap = true;
    lk.unlock();
    g_snapCv.notify_one();
    return seq;
}

bool TryGetLatestPlan(Planner::PlanResult& out)
{
    std::unique_lock<std::mutex> lk(g_planMutex, std::try_to_lock);
    if (!lk.owns_lock())
        return false;   // contention → game thread keeps its own last-known plan
    if (!g_havePlan)
        return false;   // worker still cold — no plan yet
    out = g_latestPlan;
    return true;
}

} } // namespace UDodge::Worker
