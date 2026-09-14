import { Combat } from '@realmengine/sdk';
import type { CombatAimOptions, Enemy } from '@realmengine/sdk';
import type { ClientConnection } from '../../../proxy/ClientConnection.js';
import type { BridgeDeps } from '../BridgeDeps.js';
import { warnUnimplemented } from '../stubWarn.js';
import { overrideDllFeature, restoreDllFeature, sendDllFeature } from '../../../bridge/DllFeatureBus.js';
import { pauseAutomaticAbility } from '../../../bridge/AutomaticAbilityPause.js';

const HISTORY_MS = 60 * 60 * 1000; // keep up to 1 hour of events

/**
 * Auto Aim settings that drop a lock on a structure (TargetSelector.cpp, Locked
 * branch): "Ignore walls" skips no-health-bar objects, "Ignore walls / breakables"
 * skips static objects with no projectiles, e.g. every Destructible Castle Wall.
 * `true` is the DLL's own default for both (AutoAim.cpp s_ignoreWalls/s_ignoreScenery).
 */
const STRUCTURE_FILTERS = ['autoAimIgnoreWalls', 'autoAimIgnoreScenery'] as const;

type AimTarget =
  | { kind: 'object'; objectId: number }
  | { kind: 'position'; x: number; y: number };

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeObjectId(target: unknown): number | null {
  const raw = typeof target === 'number'
    ? target
    : target && typeof target === 'object'
      ? (target as { objectId?: unknown }).objectId
      : undefined;
  const n = finiteNumber(raw);
  if (n == null || n <= 0) return null;
  return Math.trunc(n);
}

function readLocation(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') return null;
  const x = finiteNumber((value as { x?: unknown }).x);
  const y = finiteNumber((value as { y?: unknown }).y);
  if (x == null || y == null) return null;
  return { x, y };
}

export class BridgeCombat {
  static install(deps: BridgeDeps): void {
    Combat.pauseAutomaticAbility = (durationMs = 500): void => {
      const client = deps.clientRef.current;
      if (client?.connected) pauseAutomaticAbility(client, durationMs);
    };
    const shotTimes: number[] = [];
    const hitTimes: number[] = [];
    let aimTarget: AimTarget | null = null;
    let autoAimEnabled = false;

    function prune(): void {
      const cutoff = Date.now() - HISTORY_MS;
      while (shotTimes.length > 0 && shotTimes[0]! < cutoff) shotTimes.shift();
      while (hitTimes.length  > 0 && hitTimes[0]!  < cutoff) hitTimes.shift();
    }

    function clearAim(): void {
      aimTarget = null;
      autoAimEnabled = false;
    }

    Combat.setAutoFire = (enabled: boolean): boolean => {
      return sendDllFeature('autoFireEnabled', !!enabled);
    };
    Combat.setKillAura = (enabled: boolean): boolean => {
      return sendDllFeature('killauraEnabled', !!enabled);
    };

    function resolveAimPoint(client: ClientConnection): { x: number; y: number } | null {
      if (!autoAimEnabled || !aimTarget) return null;
      if (aimTarget.kind === 'position') return { x: aimTarget.x, y: aimTarget.y };

      const ws = deps.getWorldStateForClient?.(client) ?? deps.worldState;
      const entity = ws.getEntity(aimTarget.objectId);
      if (!entity) return null;
      const x = finiteNumber(entity.pos?.x);
      const y = finiteNumber(entity.pos?.y);
      if (x == null || y == null) return null;
      return { x, y };
    }

    deps.proxy.hookPacket('PLAYERSHOOT', (client, packet) => {
      shotTimes.push(Date.now());
      prune();
      if (!packet.isDefined) return;

      const point = resolveAimPoint(client);
      if (!point) return;

      const currentAngle = finiteNumber(packet.data.angle) ?? 0;
      const playerPosition =
        readLocation(packet.data.playerPosition) ??
        (() => {
          const projectilePosition = readLocation(packet.data.projectilePosition);
          if (!projectilePosition) return null;
          return {
            x: projectilePosition.x - Math.cos(currentAngle) * 0.3,
            y: projectilePosition.y - Math.sin(currentAngle) * 0.3,
          };
        })() ??
        readLocation(client.playerData.pos);

      if (!playerPosition) return;
      const dx = point.x - playerPosition.x;
      const dy = point.y - playerPosition.y;
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;

      const angle = Math.atan2(dy, dx);
      packet.data.angle = angle;
      packet.data.projectilePosition = {
        x: playerPosition.x + Math.cos(angle) * 0.3,
        y: playerPosition.y + Math.sin(angle) * 0.3,
      };
      packet.modified = true;
    });

    deps.proxy.hookPacket('ENEMYHIT', (_client, _packet) => {
      hitTimes.push(Date.now());
      prune();
    });

    Combat.accuracy = (): number => {
      prune();
      if (shotTimes.length === 0) return 0;
      return hitTimes.length / shotTimes.length;
    };

    Combat.recentAccuracy = (minutes: number): number => {
      prune();
      const cutoff = Date.now() - minutes * 60 * 1000;
      const shots = shotTimes.filter(t => t >= cutoff).length;
      if (shots === 0) return 0;
      const hits = hitTimes.filter(t => t >= cutoff).length;
      return hits / shots;
    };

    Combat.resetAccuracy = (): void => {
      shotTimes.length = 0;
      hitTimes.length = 0;
    };

    // A structure lock lifts Auto Aim's wall filters; every other aim change puts
    // the Auto Aim plugin's settings back. Only this bridge's own lift is undone.
    let structuresLifted = false;
    function liftStructureFilters(): void {
      for (const key of STRUCTURE_FILTERS) overrideDllFeature(key, false);
      structuresLifted = true;
    }
    function restoreStructureFilters(): void {
      if (!structuresLifted) return;
      structuresLifted = false;
      for (const key of STRUCTURE_FILTERS) restoreDllFeature(key, true);
    }

    Combat.aimAt = (target: number | { objectId: number }, options?: CombatAimOptions) => {
      const objectId = normalizeObjectId(target);
      if (objectId == null) return false;
      // AutoAim-only lock. KillAura chooses independently; UDodge receives its
      // boss lock through Dodge.lockEnemy after navigation reaches the area.
      clearAim();
      // Lift before locking so no frame sees the lock without the lift.
      if (options?.includeStructures) liftStructureFilters();
      else restoreStructureFilters();
      return sendDllFeature('scriptCombatTargetId', objectId);
    };
    Combat.aimAtPosition = (_x: number, _y: number) => {
      const x = finiteNumber(_x);
      const y = finiteNumber(_y);
      if (x == null || y == null) return false;
      aimTarget = { kind: 'position', x, y };
      autoAimEnabled = true;
      return true;
    };
    Combat.stopAiming = () => {
      clearAim();
      sendDllFeature('scriptCombatTargetId', 0);
      restoreStructureFilters();
    };
    Combat.autoAimOff = () => {
      clearAim();
      sendDllFeature('scriptCombatTargetId', 0);
      restoreStructureFilters();
    };
    Combat.useAbility = () => {
      warnUnimplemented('Combat.useAbility');
      return false;
    };
    Combat.useAbilityAt = (_x: number, _y: number) => {
      warnUnimplemented('Combat.useAbilityAt');
      return false;
    };
    Combat.useAbilityOn = (_enemy: Enemy) => {
      warnUnimplemented('Combat.useAbilityOn');
      return false;
    };
  }
}
