#pragma once
// SnapshotHandoff — one builder publishes whole snapshots; each reading thread
// keeps its own copy (its "view") that changes only when that thread refreshes it.
//
// EnemyTracker needs this because two threads tick it: the render thread
// (dPresent → AutoAim::Tick) and the game-update thread (uDodge sensors and the
// enemy lock). Both used to clear and refill one shared std::vector while the
// other iterated it, so a reader could see a half-built list — the locked enemy
// missing for that frame — or iterate freed storage when push_back reallocated.
//
// Contract:
//   • Publish() may be called from any thread; it copies under a short lock.
//   • Refresh(view, generation) brings a view up to the latest publish. The view
//     and its generation counter belong to ONE thread (EnemyTracker keeps them
//     thread_local), so a reference into the view stays valid, and its contents
//     unchanged, until that same thread refreshes it again.
#include <cstdint>
#include <mutex>
#include <vector>

template <typename T>
class SnapshotHandoff {
public:
    void Publish(const std::vector<T>& built)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_published = built;
        ++m_generation;
    }

    void Refresh(std::vector<T>& view, uint64_t& viewGeneration)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (viewGeneration == m_generation) return;
        view = m_published;
        viewGeneration = m_generation;
    }

private:
    std::mutex     m_mutex;
    std::vector<T> m_published;
    uint64_t       m_generation = 0;   // 0 = nothing published; views start at 0 too
};
