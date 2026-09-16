import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../script-packages/farmer/mbc-group-positioning.mjs', import.meta.url), 'utf8');
const GroupPositioning = new Function(source.replace('export default class', 'return class'))();
const player = (objectId: number, x: number, y = 0.5, extra = {}) => ({
  objectId, name: `Player${objectId}`, hp: 100, lastUpdate: 10000, position: { x, y }, ...extra,
});
function graph(points: number[][]) {
  const cells = new Map<string, any>(), parents = new Map<string, string | null>();
  let previous: string | null = null;
  for (const [x, y] of points) {
    const key = `${Math.floor(x)},${Math.floor(y)}`;
    cells.set(key, { x, y }); parents.set(key, previous); previous = key;
  }
  return { cells, parents, start: `${Math.floor(points[0][0])},${Math.floor(points[0][1])}` };
}
const straight = () => graph(Array.from({ length: 13 }, (_, index) => [index + 0.5, 0.5]));
const input = (players: any[], extra = {}) => ({
  players, selfName: 'Owner', origin: { x: 0.5, y: 0.5 }, now: 10000, graph: straight(), ...extra,
});

describe('MBC group positioning proposal', () => {
  it('prefers a dense live group over a lone nearby player', () => {
    const result = new GroupPositioning().select(input([player(1, 1.5), player(2, 6.1), player(3, 6.5), player(4, 6.9)]));
    expect(result.memberIds).toEqual([2, 3, 4]);
    expect(result.anchorId).toBe(3);
    expect(result.waypoint).toEqual({ x: 1.5, y: 0.5 });
  });
  it.each([
    { hp: 0 }, { hp: NaN }, { lastUpdate: 8000 }, { lastUpdate: undefined },
    { lastUpdate: 10001 }, { position: { x: NaN, y: 0.5 } }, { name: 'OWNER' },
  ])('does not count invalid, stale, dead or self entries: %j', invalid => {
    expect(new GroupPositioning().select(input([player(1, 6.1), player(2, 6.5), player(3, 6.9, 0.5, invalid)]))).toBeNull();
  });
  it('does not count duplicates or rely on an unknown self identity', () => {
    expect(new GroupPositioning().select(input([player(1, 6.1), player(1, 6.1), player(2, 6.5)]))).toBeNull();
    expect(new GroupPositioning().select(input([player(1, 6.1), player(2, 6.5), player(3, 6.9)], { selfName: '' }))).toBeNull();
  });
  it('rejects players outside the nearby known reachable component', () => {
    const players = [player(1, 6.1), player(2, 6.5), player(3, 6.9)];
    expect(new GroupPositioning().select(input(players, { graph: graph([[0.5, 0.5], [1.5, 0.5]]) }))).toBeNull();
    expect(new GroupPositioning().select(input(players.map(entry => ({ ...entry, position: { x: 20.5, y: 0.5 } }))))).toBeNull();
  });
  it('uses a real member, never the midpoint between two separate groups', () => {
    const players = [player(1, 3.1), player(2, 3.5), player(3, 3.9), player(4, 9.1), player(5, 9.5), player(6, 9.9)];
    const result = new GroupPositioning().select(input(players));
    expect(result.anchorId).toBe(2);
    expect(result.memberIds).toEqual([1, 2, 3]);
  });
  it('does not turn a transitive player chain into one arena-spanning group', () => {
    const result = new GroupPositioning().select(input([1, 3, 5, 7, 9, 11].map((x, index) => player(index + 1, x + 0.5))));
    expect(result.memberIds.length).toBe(3);
  });
  it('retains a viable group against a one-player population fluctuation', () => {
    const policy = new GroupPositioning();
    const first = [player(1, 3.1), player(2, 3.5), player(3, 3.9)];
    expect(policy.select(input(first)).anchorId).toBe(2);
    const second = [player(4, 9.1), player(5, 9.3), player(6, 9.7), player(7, 9.9)];
    expect(policy.select(input([...first, ...second])).memberIds).toEqual([1, 2, 3]);
    expect(policy.select(input(second)).memberIds).toEqual([4, 5, 6, 7]);
  });
  it('drops expired group state and can explicitly reset for map or boss death', () => {
    const policy = new GroupPositioning(), players = [player(1, 6.1), player(2, 6.5), player(3, 6.9)];
    expect(policy.select(input(players))).not.toBeNull();
    expect(policy.select(input(players, { now: 11001 }))).toBeNull();
    policy.reset(); expect(policy.anchorId).toBeNull();
  });
  it('routes toward the first cardinal doorway step, not a chord through the corner', () => {
    const corridor = graph([[0.5, 0.5], [0.5, 1.5], [0.5, 2.5], [1.5, 2.5], [2.5, 2.5]]);
    const players = [player(1, 2.1, 2.5), player(2, 2.5, 2.5), player(3, 2.9, 2.5)];
    expect(new GroupPositioning().select(input(players, { graph: corridor })).waypoint).toEqual({ x: 0.5, y: 1.5 });
    expect(new GroupPositioning().select(input(players, { graph: corridor, origin: { x: 0.8, y: 0.5 } })).waypoint)
      .toEqual({ x: 0.5, y: 0.5 });
  });
  it('does not claim cohesion across a wall just because players are nearby', () => {
    const corridor = graph([[0.5, 0.5], [0.5, 1.5], [0.5, 2.5], [1.5, 2.5], [2.5, 2.5], [2.5, 1.5], [2.5, 0.5]]);
    const players = [player(1, 2.1), player(2, 2.5), player(3, 2.9)];
    expect(new GroupPositioning().select(input(players, { graph: corridor })).waypoint).toEqual({ x: 0.5, y: 1.5 });
  });
  it('returns no movement pull once inside the same nearby cohesive floor area', () => {
    const players = [player(1, 1.1), player(2, 1.5), player(3, 1.9)];
    expect(new GroupPositioning().select(input(players)).waypoint).toBeNull();
  });
  it('keeps moving forward once aligned with a cardinal segment instead of recentering backward', () => {
    const players = [player(1, 6.1), player(2, 6.5), player(3, 6.9)];
    const policy = new GroupPositioning();
    expect(policy.select(input(players, { origin: { x: 0.8, y: 0.5 } })).waypoint)
      .toEqual({ x: 1.5, y: 0.5 });
    expect(policy.select(input(players, { origin: { x: 0.8, y: 0.8 } })).waypoint)
      .toEqual({ x: 0.5, y: 0.5 });
  });
  it('centers integer tile coordinates rather than targeting wall edges', () => {
    const integerTiles = graph(Array.from({ length: 8 }, (_, index) => [index, 0]));
    const players = [player(1, 6.1), player(2, 6.5), player(3, 6.9)];
    expect(new GroupPositioning().select(input(players, { graph: integerTiles })).waypoint).toEqual({ x: 1.5, y: 0.5 });
  });
  it('rejects a diagonal-only parent link rather than cutting a narrow corner', () => {
    const diagonal = graph([[0.5, 0.5], [1.5, 1.5], [2.5, 2.5]]);
    const players = [player(1, 2.1, 2.5), player(2, 2.5, 2.5), player(3, 2.9, 2.5)];
    expect(new GroupPositioning().select(input(players, { graph: diagonal }))).toBeNull();
  });
});
