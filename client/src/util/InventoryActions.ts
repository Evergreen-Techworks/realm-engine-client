// Shared by script and plugin senders. Observe authoritative slot changes before
// allowing the next automatic inventory operation, rather than racing NEWTICK.
const key = Symbol.for('realm-engine.inventory-actions');
interface Pending { at: number; map: string; read: () => string; before: string }
type Owner = { playerData: { mapName: string }; [key]?: Pending };
export function tryInventoryAction(client: Owner, read: () => string, send: () => void): boolean {
  const now = Date.now();
  const pending = client[key];
  if (pending && pending.map === client.playerData.mapName) {
    if (now - pending.at < 1300) return false;
    // Bound a failed/unacknowledged action so it cannot disable looting forever.
    if (now - pending.at < 5000 && pending.read() === pending.before) return false;
  }
  const next = { at: now, map: client.playerData.mapName, read, before: read() };
  client[key] = next;
  try { send(); } catch (error) { delete client[key]; throw error; }
  return true;
}
