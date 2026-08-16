// Shared dashboard WebSocket message-type names (server → browser).
//
// Used by BOTH ends of the dashboard socket — edit here only:
//   * the server (`src/dashboard/server/DevServer.ts`) imports WS_MSG and emits
//     `{ type: WS_MSG.* }`;
//   * the browser (`src/dashboard/public/app.js`) reads the same names via the
//     generated `public/ws-message-types.js` companion (`window.WS_MSG`), which
//     `scripts/gen-ws-types.mjs` regenerates from this file.
//
// Keeping the two copies derived from one source turns an end-to-end mismatch
// (a silent dead channel) into a missing-property error. Every value below is
// the exact wire string — do not change values, only the mapping.
//
// Scope: the message types DevServer.ts itself emits. Types emitted from other
// modules (e.g. the script-panel push types in
// `src/scripts/bridge/scriptUi/ScriptPanels.ts`) are intentionally not centered
// here — this module owns the DevServer↔app.js boundary only.
export const WS_MSG = Object.freeze({
  ALL_PLAYERS_RAW_STATS: 'allPlayersRawStats',
  CLIENT_LIST: 'clientList',
  CONFIG: 'config',
  GAME_CLIENT: 'gameClient',
  GAME_WIKI_CATALOG: 'gameWikiCatalog',
  GEM_STATUS: 'gemStatus',
  HISTORY: 'history',
  INTERNAL_STATE: 'internalState',
  LAB_PACKET_SEND_RESULT: 'labPacketSendResult',
  LAB_UPDATE: 'labUpdate',
  LAUNCH_GAME_RESULT: 'launchGameResult',
  MULING_STATUS: 'muling_status',
  NEARBY_PLAYER_DEBUG: 'nearbyPlayerDebug',
  NEARBY_PLAYERS_DATA: 'nearbyPlayersData',
  OBJECTS_DATA: 'objectsData',
  OBJECT_XML_RESULT: 'objectXmlResult',
  PACKET: 'packet',
  PLAYER_DATA: 'playerData',
  PLUGIN_DATA: 'pluginData',
  PLUGIN_HOTKEY_UPDATE_ERROR: 'pluginHotkeyUpdateError',
  PLUGIN_LOG: 'pluginLog',
  PLUGINS: 'plugins',
  PLUGIN_SETTINGS_RESET: 'pluginSettingsReset',
  PLUGIN_TOGGLE_ERROR: 'pluginToggleError',
  PROBE_RESULT: 'probeResult',
  SCRIPT_LOG: 'scriptLog',
  SCRIPT_PANEL_STATE: 'scriptPanelState',
  SCRIPTS_STATE: 'scriptsState',
  SETTING_UPDATE_ERROR: 'settingUpdateError',
  TILES_DATA: 'tilesData',
  TILE_XML_RESULT: 'tileXmlResult',
  UNRESOLVED_CLASSES: 'unresolvedClasses',
  VAULT_DATA: 'vaultData',
});

export type WsMsgType = (typeof WS_MSG)[keyof typeof WS_MSG];
