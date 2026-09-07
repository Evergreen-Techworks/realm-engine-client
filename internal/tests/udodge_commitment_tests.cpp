#include "UDodgeWorker.h"
#include <chrono>
#include <thread>
#include <cstdio>
using namespace UDodge;
// Isolate the worker/solver handoff from grid search. The real WorkerLoop and
// real solver still run on the worker thread with the published snapshot.
namespace UDodge { namespace Path {
void Compute(const PlannerSnapshot& in, PlanResult& out) { out = {}; out.forSeq = in.seq; }
} }
static int checks = 0, failures = 0;
static void Check(bool ok, const char* name) {
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); }
}
static bool Publish(const Path::PlannerSnapshot& snapshot) {
    const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (std::chrono::steady_clock::now() < end) {
        if (Worker::PublishSnapshot(snapshot) != 0) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return false;
}
static bool Await(Worker::Result& result) {
    const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (std::chrono::steady_clock::now() < end) {
        if (Worker::TryGetLatest(result)) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return false;
}
int main() {
    MovementCommitment committed{}; CoreState proposed{};
    proposed.lastMoveDir = {1.f,0.f};
    Check(!committed.Record(proposed, {1.f,0.f}, false) && committed.revision == 0, "rejected movement cannot change history");
    Check(!committed.Record(proposed, {}, true) && committed.revision == 0, "zero-length movement cannot change history");
    committed.Record(proposed, {1.f,0.f}, true);
    const auto eastRevision = committed.revision;
    Check(eastRevision != 0 && committed.state.lastMoveDir.x == 1.f, "successful command records heading");
    committed.Record(proposed, {2.f,0.f}, true);
    Check(committed.revision == eastRevision, "continued heading does not invalidate worker every frame");

    static Path::PlannerSnapshot snap{};
    snap.speed = .005f; snap.moveBudget = 1.f;
    snap.map.zoneCount = 1;
    snap.map.zones[0].radius = 3.f; // pending telegraph makes a symmetric move useful
    snap.commitment = committed;
    Worker::Start();
    Check(Publish(snap), "publish first commitment snapshot");
    Worker::Result east{};
    const bool first = Await(east);
    Check(first && east.solve.shouldMove && east.solveState.lastMoveDir.x > .99f, "worker starts with game-thread east heading");
    Check(first && committed.Accepts(east.commitmentRevision), "matching worker result can be adopted");

    // Emergency moves north while a result computed from east exists.
    proposed.lastMoveDir = {0.f,1.f};
    committed.Record(proposed, {0.f,1.f}, true);
    Check(!committed.Accepts(east.commitmentRevision), "old result cannot override newer emergency commitment");
    snap.commitment = committed;
    Check(Publish(snap), "publish emergency commitment snapshot");
    Worker::Result north{};
    const bool second = Await(north);
    Check(second && north.solve.shouldMove && north.solveState.lastMoveDir.y > .99f,
          "worker uses new north commitment instead of its private east history");
    Check(second && committed.Accepts(north.commitmentRevision), "new worker decision matches latest revision");
    Worker::Stop();
    const auto previous = committed.revision;
    committed.Reset();
    Check(!committed.Accepts(previous) && LenSq(committed.state.lastMoveDir) == 0.f, "reset invalidates prior-world commitment");
    std::printf("Commitment tests: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
