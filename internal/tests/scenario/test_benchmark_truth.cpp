#include "benchmark_truth.h"
#include <cassert>
int main() {
    BenchmarkHealth h; h.enabled=true;
    h.Hit(0,500); h.Advance(0);
    assert(h.hp==120 && h.confirmedHp==600 && h.requestMs<0);
    h.Hit(10,80); h.Advance(10);
    assert(h.hp==60 && h.requestMs==10 && h.escapeMs<0);
    h.Hit(50,100); h.Advance(110);
    assert(h.deathMs==50 && h.escapeMs<0); // request != survived
    assert(h.Peak(100)==620);
    BenchmarkHealth stall; stall.enabled=true;
    stall.Hit(0,550); stall.Advance(50,false);
    assert(stall.hp==70 && stall.requestMs<0);
    stall.Hit(100,100); stall.Advance(250);
    assert(stall.deathMs==100 && stall.requestMs<0);
    BenchmarkHealth safe; safe.enabled=true;
    safe.Hit(0,550); safe.Advance(0); safe.Advance(100);
    assert(safe.escapeMs==100 && safe.deathMs<0);
    safe.Advance(200); assert(safe.confirmedHp==70 && safe.escapeMs==100);
}
