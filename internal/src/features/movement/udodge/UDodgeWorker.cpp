#include "pch-il2cpp.h"
#include "UDodgeWorker.h"
#include "UDodgePathfinder.h"

#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>

// ─────────────────────────────────────────────────────────────────────────────
// IL2CPP-FREE ZONE. Nothing in this file — and nothing WorkerLoop reaches —
// may call il2cpp_*, read a game object, or dereference an Env function pointer.
// The worker thread races the GC if it touches live world memory. It operates
// ONLY on the plain-data Path::PlannerSnapshot and writes a plain-data
// Path::PlanResult; Path::Compute is likewise pure math (its local MapInput's
// .env is NULL and its .map aliases only the plain snapshot copy).
//
// The handoff mirrors the proven render-overlay publish (UDodge.cpp g_debugMutex)
// and the retired plan-59 worker: the game thread never blocks — it try_to_locks
// and drops the frame on contention. The worker may block only on its own CV wait
// and the brief lock hold during the copy-out.
// ─────────────────────────────────────────────────────────────────────────────
namespace UDodge { namespace Worker {
namespace {

std::thread              g_thread;
std::atomic<bool>        g_running{ false };   // guards double-start / late Stop
std::atomic<bool>        g_stop{ false };

// g_snapMutex guards the pending snapshot handed game → worker.
std::mutex               g_snapMutex;
std::condition_variable  g_snapCv;
Path::PlannerSnapshot    g_pendingSnap;
bool                     g_haveSnap = false;
uint32_t                 g_seq = 0;            // monotonic publish sequence

// g_planMutex guards the latest plan handed worker → game.
std::mutex               g_planMutex;
Result                   g_latest;
bool                     g_havePlan = false;

void WorkerLoop()
{
    // Worker-owned copies — never alias game state. Heap-free steady state.
    static Path::PlannerSnapshot local;   // large; keep off the thread stack
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
        Path::PlanResult plan{};
        Path::Compute(local, plan);

        MapInput in{};
        in.player = local.player;
        in.speed = local.speed;
        in.stepTiles = local.moveBudget;
        in.tickId = local.tickId;
        in.playerOnHazard = local.playerOnHazard;
        in.settings = local.settings;
        in.map = &local.map;
        in.env.occFlags = local.grid.flags;
        in.env.occCenter = local.grid.center;
        in.env.occSide = kUPathMaxSide;
        in.env.occRadius = kUPathMaxRadCells;
        in.env.occCellTiles = kUPathCellTiles;

        Solver::Goal goal{};
        goal.active = local.goalActive;
        goal.pos = local.goalPos;
        goal.walkTo = local.goalWalkTo;
        // Path::Compute may have produced a brand-new navigation corridor from
        // this snapshot. Solve against that corridor's immediate step, not the
        // pre-compute goal submitted by the game thread. Otherwise the overlay
        // shows a correct cyan path while the yellow committed move follows the
        // previous/raw goal for another worker cycle.
        if (goal.walkTo && plan.navFound)
            goal.pos = plan.navStepTarget;
        goal.fromLock = local.hasLock;
        goal.lockPos = local.lockPos;
        goal.maxRange = local.weaponRangeTiles;
        goal.innerStandoff = local.innerStandoffTiles;

        CoreState solveState = local.commitment.state;
        Solver::SolveResult solve{};
        Solver::Solve(in, local.moveBudget, goal, plan, solveState, solve);
        {
            std::lock_guard<std::mutex> lk(g_planMutex);
            g_latest.plan = plan;
            g_latest.solve = solve;
            g_latest.solveState = solveState;
            g_latest.commitmentRevision = local.commitment.revision;
            g_latest.snapshotPlayer = local.player;
            g_latest.walkGoal = local.navGoal;
            g_latest.walkActive = local.goalWalkTo;
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

uint32_t PublishSnapshot(const Path::PlannerSnapshot& snap)
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

bool TryGetLatest(Result& out)
{
    std::unique_lock<std::mutex> lk(g_planMutex, std::try_to_lock);
    if (!lk.owns_lock())
        return false;   // contention → game thread keeps its own last-known plan
    if (!g_havePlan)
        return false;   // worker still cold — no plan yet
    out = g_latest;
    g_havePlan = false; // consume once; do not overwrite live state every frame
    return true;
}

} } // namespace UDodge::Worker
