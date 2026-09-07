import { World } from '@realmengine/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import { GameId } from '../../../constants/GameId.js';
import { warnUnimplemented } from '../stubWarn.js';

function mapNameLower(deps: BridgeDeps): string {
  return (deps.clientRef.current?.playerData?.mapName ?? '').toLowerCase();
}

export class BridgeWorld {
  static install(deps: BridgeDeps): void {
    World.getSize = () => {
      const p = deps.clientRef.current?.playerData;
      return { width: p?.mapWidth ?? 0, height: p?.mapHeight ?? 0 };
    };
    World.isNexus = () => {
      const gid = deps.clientRef.current?.state?.gameId;
      if (gid === GameId.Nexus) return true;
      return mapNameLower(deps).includes('nexus');
    };
    World.isRealm = () => {
      // Live Realm shards use gameId 0 even when MAPINFO.displayName is a
      // generated shard title such as "Mesa" rather than "Realm".
      const gid = deps.clientRef.current?.state?.gameId;
      if (gid === 0) return true;
      const n = mapNameLower(deps);
      return n.includes('realm of the mad god') || n === 'realm';
    };
    World.isDungeon = () => {
      warnUnimplemented('World.isDungeon');
      return false;
    };
    World.isVault = () => {
      const gid = deps.clientRef.current?.state?.gameId;
      if (gid === GameId.Vault) return true;
      return mapNameLower(deps).includes('vault');
    };
    World.getName = () => {
      const p = deps.clientRef.current?.playerData;
      return p?.mapName ?? '';
    };
  }
}
