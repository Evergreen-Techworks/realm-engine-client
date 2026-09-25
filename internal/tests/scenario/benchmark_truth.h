#pragma once
#include <algorithm>
#include <vector>
#include <utility>

// Benchmark-only model, not a replacement for production AutoNexus.
// Truth HP, delayed confirmed HP, and delayed escape are distinct states.
struct BenchmarkHealth {
    double hp = 600, maxHp = 600, defense = 20, confirmedHp = 600;
    double threshold = .12, observationDelayMs = 200, escapeDelayMs = 100;
    double requestMs = -1, escapeMs = -1, deathMs = -1, minHp = 600;
    std::vector<std::pair<double,double>> pending, damage;
    bool enabled = false;
    void Hit(double now, double raw, bool armorPiercing = false) {
        if (!enabled || deathMs >= 0 || escapeMs >= 0) return;
        const double amount = armorPiercing ? raw : std::max(raw*.15, raw-defense);
        hp -= amount; minHp = std::min(minHp,hp);
        damage.push_back({now,amount}); pending.push_back({now+observationDelayMs,hp});
        if (hp <= 0) deathMs = now;
    }
    void Advance(double now, bool controllerRuns = true) {
        for (auto& sample : pending)
            if (sample.first <= now) { confirmedHp = sample.second; sample.first = 1e30; }
        if (!enabled || deathMs >= 0) return;
        // Benchmark ledger is immediate; confirmed HP can lag. A request is
        // only issued on a controller frame and never cancels in-flight damage.
        if (controllerRuns && requestMs < 0 && std::min(hp,confirmedHp) <= maxHp*threshold) requestMs = now;
        if (escapeMs < 0 && requestMs >= 0 && now >= requestMs+escapeDelayMs) escapeMs = now;
    }
    double Peak(double windowMs) const {
        double best=0;
        for (auto end:damage) {
            double total=0;
            for (auto item:damage) if(item.first>=end.first-windowMs && item.first<=end.first) total+=item.second;
            best=std::max(best,total);
        }
        return best;
    }
};
