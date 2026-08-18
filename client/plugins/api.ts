/**
 * `plugins/api.ts` — the built-in plugin boundary.
 *
 * Bundled first-party plugins in `client/plugins/**` legitimately reach into
 * the client's internals (proxy, world state, the DLL feature bus, packets).
 * This barrel re-exports exactly the internal surface they are allowed to use,
 * so that boundary lives in one greppable file instead of being scattered
 * across ~30 deep `../src/...` imports. It removes no capability — it just makes
 * the seam visible and stable (a future lint rule or tightening has one place to
 * anchor to).
 *
 * Type-only re-exports are erased at build; the value re-exports are core,
 * side-effect-free infra. Deliberately NOT routed through here (they stay direct
 * imports in their single consuming plugin, to avoid pulling one-off / native
 * modules into every plugin's graph): `native/rotmg-shared` (auto-aim, native
 * boundary), the `damage-sniffer/*` internals plus `util/rotmgAssetExtractor`
 * and `util/mapDisplayName` (damage-sniffer only), and
 * `services/ServerListFetcher` + `config/BakedData` (server-switch only).
 */

// ── Types (erased at build) ──────────────────────────────────────────
export type { PluginContext } from '../src/plugins/PluginContext.js';
export type { ClientConnection } from '../src/proxy/ClientConnection.js';
export type { Packet } from '../src/packets/Packet.js';
export type { GameWorldState, TrackedEntity } from '../src/state/GameWorldState.js';
export type { GameDataLoader, PlayerClassStatMaxes } from '../src/game-data/GameDataLoader.js';
export type { DllThreat, DllGround } from '../src/bridge/DllThreatBus.js';

// ── Values (core infra) ──────────────────────────────────────────────
export { sendDllFeature } from '../src/bridge/DllFeatureBus.js'; // typed via plan 12
export { StatType } from '../src/constants/StatType.js';
export { ConditionEffect } from '../src/constants/ConditionEffect.js';
export { ClassId } from '../src/constants/ClassId.js';
export { RuntimeScheduler } from '../src/util/RuntimeScheduler.js';
export { getDllThreats, getDllGround, getDllThreatsAgeMs, getDllThreatsTruncated } from '../src/bridge/DllThreatBus.js';
