import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import type { Packet } from '../packets/Packet.js';
import { PacketReader } from '../packets/PacketReader.js';
import { PlayerData } from './PlayerData.js';
import { Logger } from '../util/Logger.js';
import { dumpLocalPlayerStats } from '../util/StatDump.js';
import { normalizeMapDisplayName } from '../util/mapDisplayName.js';

/**
 * Hooks core packets to maintain PlayerData state.
 * Ported from KRelayBetter's StateManager.cs.
 */
export class StateManager {
  private proxy: Proxy | null = null;
  /** Returns the DLL's authoritative memory defense (null if unavailable / not alive). */
  private dllDefenseSource: (() => number | null) | null = null;
  private defenseCalibrated = false;

  /** Wire in the DLL's memory defense so we can self-check the wire defense model on load. */
  setDllDefenseSource(fn: () => number | null): void {
    this.dllDefenseSource = fn;
  }

  /**
   * One-time-per-load self-check: compares the wire-reconstructed defense against
   * the DLL's authoritative memory defense to auto-determine whether DEFENSE_STAT(21)
   * is already EFFECTIVE (so `pd.defense + pd.defenseBonus` double-counts) or BASE
   * (so the add is correct). Logs the verdict and re-arms when the player dies /
   * changes maps (DLL defense goes null). No-op until a DLL defense is available.
   */
  private checkDefenseCalibration(pd: PlayerData): void {
    const dllDef = this.dllDefenseSource ? this.dllDefenseSource() : null;
    if (dllDef === null) { this.defenseCalibrated = false; return; }  // re-arm for next load
    if (this.defenseCalibrated) return;

    const wireBase = pd.defense;
    const wireSum = pd.defense + pd.defenseBonus;
    const matchesBase = Math.abs(dllDef - wireBase) <= 1;
    const matchesSum = Math.abs(dllDef - wireSum) <= 1;

    if (matchesBase && matchesSum) {
      // defenseBonus is 0 right now — can't disambiguate. Stay armed and retry with gear/exalt.
      return;
    }
    this.defenseCalibrated = true;
    if (matchesBase) {
      Logger.log('DefenseCheck', `DEFENSE(21)=${wireBase} == DLL memory ${dllDef} → stat 21 is EFFECTIVE; `
        + `'pd.defense + pd.defenseBonus' (${wireSum}) double-counts. AutoNexus already uses the memory value.`);
    } else if (matchesSum) {
      Logger.log('DefenseCheck', `DEFENSE(21)+DEFENSE_BOOST(49)=${wireSum} == DLL memory ${dllDef} → stat 21 is BASE; `
        + `the bonus add is correct.`);
    } else {
      Logger.warn('DefenseCheck', `Neither wire base (${wireBase}) nor base+bonus (${wireSum}) == DLL memory ${dllDef} `
        + `— stat-type drift or wrong memory field. Inspect with RE_STAT_DUMP=1.`);
    }
  }

  attach(proxy: Proxy): void {
    this.proxy = proxy;
    proxy.hookPacket('CREATESUCCESS', (c, p) => this.onCreateSuccess(c, p));
    proxy.hookPacket('MAPINFO', (c, p) => this.onMapInfo(c, p));
    proxy.hookPacket('UPDATE', (c, p) => this.onUpdate(c, p));
    proxy.hookPacket('NEWTICK', (c, p) => this.onNewTick(c, p));
    proxy.hookPacket('MOVE', (c, p) => this.onMove(c, p));
    proxy.hookPacket('TELEPORT', (c, p) => this.onTeleport(c, p));
    proxy.hookPacket('GOTO', (c, p) => this.onGoto(c, p));
    proxy.hookPacket('NOTIFICATION', (c, p) => this.onNotification(c, p));
    proxy.hookPacket('PLAYERSHOOT', (c, p) => this.onPlayerShoot(c, p));
    proxy.hookPacket('PONG', (c, p) => this.onPong(c, p));
    proxy.hookPacket('QUESTOBJECTID', (c, p) => this.onQuestObjectId(c, p));
  }

  private onQuestObjectId(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    const raw = Math.trunc(Number((packet.data as { objectId?: number }).objectId));
    client.playerData.questObjectId = Number.isFinite(raw) ? raw : -1;
  }

  private onCreateSuccess(client: ClientConnection, packet: Packet): void {
    // MAPINFO normally precedes CREATESUCCESS. Reset character data while
    // retaining the current connection's already received map metadata.
    const { mapName, mapWidth, mapHeight, teleportAllowed } = client.playerData;
    client.playerData = new PlayerData();
    Object.assign(client.playerData, { mapName, mapWidth, mapHeight, teleportAllowed });
    client.playerData.ownerObjectId = packet.data.objectId;
    client.lastTeleportSentAt = 0;
    client.lastTeleportGotoAt = 0;
    client.pendingTeleportSentAt = 0;
    client.pendingTeleportTargetObjectId = null;
    Logger.log('State', `Player created with objectId ${packet.data.objectId}`);
  }

  private onMapInfo(client: ClientConnection, packet: Packet): void {
    // RotmgPlayer uses displayName when present, falling back to name
    const displayName = packet.data.displayName ?? '';
    const name = packet.data.name ?? '';
    client.playerData.mapName = normalizeMapDisplayName(displayName, name);
    client.playerData.mapWidth = packet.data.width ?? 0;
    client.playerData.mapHeight = packet.data.height ?? 0;
    client.playerData.teleportAllowed = packet.data.allowPlayerTeleport ?? false;
    client.pendingTeleportSentAt = 0;
    client.pendingTeleportTargetObjectId = null;
    client.playerData.vaultContent = [];
    client.playerData.vaultChestObjectId = -1;
    client.playerData.questObjectId = -1;
    Logger.log('State', `Map: ${packet.data.name} (${packet.data.width}x${packet.data.height})`);
  }

  private onUpdate(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined || !packet.data.newObjs) return;

    for (const entity of packet.data.newObjs) {
      const status = entity.status;
      if (!status) continue;

      // Check if this entity is our player
      if (status.objectId === client.objectId) {
        const entityObjectType = Number(entity.objectType);
        if (Number.isFinite(entityObjectType) && entityObjectType > 0) {
          client.playerData.classType = Math.trunc(entityObjectType);
        }
        client.playerData.pos = { ...status.position };
        if (status.data) {
          client.playerData.parseStatus(status.data);
          dumpLocalPlayerStats(status.data, 'UPDATE');
          this.checkDefenseCalibration(client.playerData);

          // Account ID matching for state persistence across reconnects
          if (client.playerData.accountId && client.state) {
            if (!client.state.accountId) {
              client.state.accountId = client.playerData.accountId;
            }
          }
        }
      }
    }
  }

  private onNewTick(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined || !packet.data.statuses) return;

    if (packet.data.tickId !== undefined) {
      client.lastNewTickId = Number(packet.data.tickId) || 0;
    }
    if (packet.data.serverRealTimeMs !== undefined) {
      client.lastServerRealTimeMs = Number(packet.data.serverRealTimeMs) || 0;
    }

    for (const status of packet.data.statuses) {
      if (status.objectId === client.objectId) {
        // Update position
        if (status.position) {
          client.playerData.pos = { ...status.position };
        }
        // Update stats
        if (status.data) {
          client.playerData.parseStatus(status.data);
          dumpLocalPlayerStats(status.data, 'NEWTICK');
          this.checkDefenseCalibration(client.playerData);
        }
      }
    }
  }

  private onMove(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    client.lastClientMoveAt = Date.now();
    client.previousTime = packet.data.serverRealTimeMSofLastNewTick ?? 0;
    client.lastServerRealTimeMs = Number(packet.data.serverRealTimeMSofLastNewTick ?? client.lastServerRealTimeMs) || 0;
    client.lastUpdate = Date.now();
    // Calibrate game time from first record's timestamp (MOVE records contain client game time)
    if (client.relativeTime === 0) {
      const records = packet.data.records as Array<{ time: number }> | undefined;
      if (records && records.length > 0 && records[0].time) {
        client.relativeTime = records[0].time - Date.now();
      }
    }

  }

  /**
   * A sent TELEPORT is answered by exactly one of:
   *   GOTO                          — the server moved us. Success.
   *   NOTIFICATION TELEPORT_ERROR   — the server refused (cooldown, ...).
   *   nothing                       — treated as a refusal once the window lapses.
   * That is the protocol's own success/failure signal, so nothing here has to
   * read message text or depend on the server's wording or language.
   */
  private static readonly TELEPORT_REPLY_WINDOW_MS = 1500;
  // NOTIFICATION's typeValue tag for a teleport refusal: NotificationEffect
  // .TELEPORT_ERROR in realmlib's table of the client's enum, and the tag on the
  // captured "Wait 48 seconds to teleport after server change". Every other
  // tag is some other pop-up — OBJECT (6) "+N" pop-ups over nearby players
  // arrive every second or two while farming, easily inside the reply window —
  // and must not be taken for the server's answer.
  private static readonly NOTIFICATION_TELEPORT_ERROR = 9;
  // Fallback hold when the refusal carries no readable duration. Only used if
  // the payload cannot be decoded — the server normally states the wait.
  private static readonly TELEPORT_REFUSED_BACKOFF_MS = 10000;
  // Sanity band for a server-stated wait, so a mis-decode cannot park teleports
  // for hours (or for no time at all).
  private static readonly TELEPORT_WAIT_MIN_MS = 1000;
  private static readonly TELEPORT_WAIT_MAX_MS = 600000;
  // Land just past the boundary rather than exactly on it.
  private static readonly TELEPORT_WAIT_MARGIN_MS = 250;

  /**
   * Open the reply window for a TELEPORT on its way to the server.
   *
   * A TELEPORT the game client sends reaches this through the packet hook. A
   * TELEPORT a script sends does NOT: the bridge injects it with
   * ClientConnection.sendToServer, which writes straight to the socket and
   * never fires hooks. The bridge must call this itself, or the server's
   * refusal arrives with no teleport pending and is ignored.
   */
  noteTeleportSent(client: ClientConnection, targetObjectId: number): void {
    client.lastTeleportSentAt = Date.now();
    client.pendingTeleportSentAt = client.lastTeleportSentAt;
    client.pendingTeleportTargetObjectId = Number(targetObjectId) || null;
  }

  private onTeleport(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    this.noteTeleportSent(client, Number(packet.data.objectId ?? 0));
  }

  private onNotification(client: ClientConnection, packet: Packet): void {
    if (client.pendingTeleportSentAt <= 0) return;   // not answering a teleport
    const now = Date.now();
    if ((now - client.pendingTeleportSentAt) > StateManager.TELEPORT_REPLY_WINDOW_MS) return;
    const typeValue = Number(packet.data?.typeValue ?? -1);
    if (typeValue !== StateManager.NOTIFICATION_TELEPORT_ERROR) return;   // an unrelated pop-up

    client.pendingTeleportSentAt = 0;
    client.pendingTeleportTargetObjectId = null;

    // WHY the refusal is detected by protocol but the DURATION comes from text:
    // the server telling us "no" is unambiguous (a TELEPORT_ERROR answered the
    // TELEPORT instead of GOTO), so the decision never depends on wording. The
    // number of seconds, however, exists only inside the message. Parse it when
    // we can and fall back to a conservative hold when we cannot — a wrong
    // duration costs a little time, never a wrong decision.
    //
    // NOTIFICATION is a tagged union and our generated definition stops after
    // the typeValue/textByte tag bytes, so the message is not a parsed field: it
    // is left in packet.unreadData as a protocol string (int16 length prefix,
    // then UTF-8). Observed (typeValue 9):
    //   "Wait 48 seconds to teleport after server change"
    // (`_unreadTrailingHex` is only the dashboard inspector's hex copy of those
    // bytes — it does not exist on the packet the hooks receive.)
    // Deliberately loose — any "<n> second(s)" — because the wording varies by
    // refusal reason ("...after server change" vs other cooldowns).
    let waitMs = StateManager.TELEPORT_REFUSED_BACKOFF_MS;
    let message = '';
    if (packet.isDefined && packet.unreadData.length > 2) {
      try {
        message = new PacketReader(packet.unreadData).readString();
        const m = /(\d+(?:\.\d+)?)\s*second/i.exec(message);
        if (m) {
          const stated = Math.round(Number(m[1]) * 1000) + StateManager.TELEPORT_WAIT_MARGIN_MS;
          if (stated >= StateManager.TELEPORT_WAIT_MIN_MS && stated <= StateManager.TELEPORT_WAIT_MAX_MS) {
            waitMs = stated;
          }
        }
      } catch { /* undecodable payload — keep the fallback */ }
    }
    client.teleportBlockedUntil = now + waitMs;
    Logger.warn('State', `[TELEPORT-REFUSED] typeValue=${typeValue} `
      + `wait=${(waitMs / 1000).toFixed(1)}s msg="${message}"`);
  }

  private onGoto(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    if (Number(packet.data.objectId ?? -1) !== client.objectId) return;

    if (packet.data.position) {
      client.playerData.pos = { ...packet.data.position };
    }

    const now = Date.now();
    if (client.pendingTeleportSentAt > 0 && (now - client.pendingTeleportSentAt) <= 5000) {
      client.lastTeleportGotoAt = now;
      client.pendingTeleportSentAt = 0;
      client.pendingTeleportTargetObjectId = null;
    } else if (client.pendingTeleportSentAt > 0 && (now - client.pendingTeleportSentAt) > 5000) {
      // Answered by nothing within the window — treat as refused and back off,
      // rather than letting a caller retry straight into the same rejection.
      client.pendingTeleportSentAt = 0;
      client.pendingTeleportTargetObjectId = null;
      client.teleportBlockedUntil = now + StateManager.TELEPORT_REFUSED_BACKOFF_MS;
    }
  }

  private onPong(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    // PONG is sent very early (in response to server PING) and carries the client's game time.
    // Use it as the earliest possible calibration point for client.time.
    if (client.relativeTime === 0 && packet.data.time) {
      client.relativeTime = (packet.data.time as number) - Date.now();
    }
  }

  private onPlayerShoot(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;

    // Time synchronization: calculate offset between server and client time
    if (client.relativeTime === 0) {
      client.relativeTime = (packet.data.time ?? 0) - Date.now();
    }

    // Infer player position from projectile origin
    // Projectile spawns 0.3 units from player center
    const projPos = packet.data.projectilePosition;
    const angle = packet.data.angle ?? 0;
    if (projPos) {
      client.playerData.pos = {
        x: projPos.x - Math.cos(angle) * 0.3,
        y: projPos.y - Math.sin(angle) * 0.3,
      };
    }

    client.lastUpdate = Date.now();
  }
}
