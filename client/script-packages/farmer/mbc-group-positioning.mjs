const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);
const cell = position => `${Math.floor(position.x)},${Math.floor(position.y)}`;
const valid = position => Number.isFinite(position?.x) && Number.isFinite(position?.y);
const center = position => ({ x: Math.floor(position.x) + 0.5, y: Math.floor(position.y) + 0.5 });

function pathTo(graph, position) {
  const path = [], seen = new Set();
  for (let key = cell(position); key !== graph.start; key = graph.parents.get(key)) {
    if (path.length >= 18 || seen.has(key) || !graph.parents.has(key) || !valid(graph.cells.get(key))) return null;
    seen.add(key); path.push(center(graph.cells.get(key)));
  }
  path.reverse();
  let previous = graph.cells.get(graph.start);
  if (!valid(previous)) return null;
  previous = center(previous);
  for (const next of path) {
    if (Math.abs(next.x - previous.x) + Math.abs(next.y - previous.y) !== 1) return null;
    previous = next;
  }
  return path;
}

export default class MbcGroupPositioning {
  constructor() { this.reset(); }
  reset() { this.anchorId = null; }

  select({ players, selfName, origin, now, graph }) {
    if (!selfName || !valid(origin) || !Number.isFinite(now) || !graph?.parents || !graph.cells
      || graph.start !== cell(origin)) { this.reset(); return null; }
    const entries = new Map();
    for (const player of players) {
      if (!Number.isInteger(player.objectId) || player.objectId <= 0 || entries.has(player.objectId)
        || String(player.name).toLowerCase() === selfName.toLowerCase()
        || !Number.isFinite(player.hp) || player.hp <= 0 || !valid(player.position)
        || !Number.isFinite(player.lastUpdate) || now - player.lastUpdate < 0 || now - player.lastUpdate > 1000
        || distance(origin, player.position) > 12) continue;
      const path = pathTo(graph, player.position);
      if (path) entries.set(player.objectId, { ...player, path });
    }
    const candidates = [...entries.values()].map(anchor => {
      const members = [...entries.values()].filter(member => distance(member.position, anchor.position) <= 2.5);
      return { anchor, members, spread: members.reduce((sum, member) => sum + distance(member.position, anchor.position), 0) };
    }).filter(candidate => candidate.members.length >= 3);
    candidates.sort((first, second) => second.members.length - first.members.length
      || first.spread - second.spread || first.anchor.path.length - second.anchor.path.length
      || first.anchor.objectId - second.anchor.objectId);
    let chosen = candidates[0];
    const retained = candidates.find(candidate => candidate.anchor.objectId === this.anchorId);
    if (retained && chosen.members.length < retained.members.length + 2) chosen = retained;
    if (!chosen) { this.reset(); return null; }
    this.anchorId = chosen.anchor.objectId;
    const currentCenter = center(origin);
    const cohesive = chosen.anchor.path.length <= 2 && distance(origin, chosen.anchor.position) <= 2;
    const waypoint = cohesive ? null : distance(origin, currentCenter) > 0.05
      ? currentCenter : chosen.anchor.path[0] ?? null;
    return {
      anchorId: this.anchorId,
      anchor: { ...chosen.anchor.position },
      memberIds: chosen.members.map(member => member.objectId).sort((first, second) => first - second),
      waypoint: waypoint && { ...waypoint },
    };
  }
}
