import { chat } from '@realmengine/sdk';
import type { ChatChannel, ChatEvent, ChatHandler, ChatOutgoingBlockMode } from '@realmengine/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import type { ClientConnection } from '../../../proxy/ClientConnection.js';
import type { Packet } from '../../../packets/Packet.js';
import { Logger } from '../../../util/Logger.js';

const handlers: ChatHandler[] = [];

type ChatFilterRule = {
  words: string[];
  minStars: number | null;
};

const filterRules: ChatFilterRule[] = [];

let textHookRegistered = false;
let textFilterHookRegistered = false;
let playertextBlockHookRegistered = false;

type OutgoingBlockRule = { mode: ChatOutgoingBlockMode; needles: string[] };

const outgoingBlockRules: OutgoingBlockRule[] = [];

/**
 * Runs before ordinary PLAYERTEXT hooks. Drops client → server when a `blockOutgoing` rule matches.
 */
function onOutgoingPlayertextBlock(_client: ClientConnection, packet: Packet): void {
  if (outgoingBlockRules.length === 0) return;
  if (packet.name !== 'PLAYERTEXT' || !packet.isDefined || !packet.data) return;
  const raw = String((packet.data as Record<string, unknown>).text ?? '');
  const lowerFull = raw.toLowerCase();
  const lowerTrim = raw.trim().toLowerCase();
  for (const rule of outgoingBlockRules) {
    if (rule.mode === 'equals') {
      if (rule.needles.some((n) => lowerTrim === n)) {
        packet.send = false;
        return;
      }
    } else if (rule.needles.some((n) => lowerFull.includes(n))) {
      packet.send = false;
      return;
    }
  }
}

function localPlayerName(client: ClientConnection): string {
  return (client.playerData?.name ?? '').trim();
}

function inferChannel(d: Record<string, unknown>, selfName: string): ChatChannel {
  const name = String(d.name ?? '').trim();
  const recipient = String(d.recipient ?? '').trim();
  const clean = String(d.cleanText ?? d.text ?? '');
  const self = selfName.trim().toLowerCase();

  if (recipient && self && recipient.toLowerCase() === self && name.toLowerCase() !== self) {
    return 'tell';
  }
  if (!name || name === '*' || name === '#') {
    return 'system';
  }
  if (clean.startsWith('Party>')) {
    return 'party';
  }
  if (clean.startsWith('Guild>')) {
    return 'guild';
  }
  if (clean.startsWith('Tell>') || clean.startsWith('[Tell]')) {
    return 'tell';
  }
  if (/\[.*Global.*\]/i.test(clean)) {
    return 'global';
  }
  return 'say';
}

function textPacketToChatEvent(client: ClientConnection, d: Record<string, unknown>): ChatEvent {
  const selfName = localPlayerName(client);
  const sender = String(d.name ?? '').trim();
  const message = String(d.cleanText ?? d.text ?? '');
  const channel = inferChannel(d, selfName);
  const isLocal = selfName.length > 0 && sender.toLowerCase() === selfName.toLowerCase();
  // `isEcho` is an extra host-only field (TEXT packets are always server echoes).
  // Present on the event for downstream consumers; SDK's `ChatEvent` type doesn't declare it.
  return {
    sender,
    sourceObjectId: Number.isInteger(d.objectId) && Number(d.objectId) > 0 ? Number(d.objectId) : undefined,
    message,
    channel,
    isLocal,
    isEcho: true,
    timestamp: Date.now(),
  } as ChatEvent;
}

function onTextPacket(client: ClientConnection, packet: Packet): void {
  if (packet.name !== 'TEXT' || !packet.isDefined || !packet.data) return;
  notifyChatListeners(textPacketToChatEvent(client, packet.data as Record<string, unknown>));
}

function onPlayerTextPacket(client: ClientConnection, packet: Packet): void {
  if (packet.name !== 'PLAYERTEXT' || !packet.isDefined || !packet.data) return;
  const message = String((packet.data as Record<string, unknown>).text ?? '').trim();
  if (!message) return;
  notifyChatListeners({
    sender: localPlayerName(client),
    message,
    channel: 'say',
    isLocal: true,
    // PLAYERTEXT is the outgoing message — not an echo (host-only extra field).
    isEcho: false,
    timestamp: Date.now(),
  } as ChatEvent);
}

/** Default "sender" name shown on client-only notifications (`chat.notify`). Mirrors `PluginContext.sendNotification`. */
const DEFAULT_NOTIFICATION_SENDER = 'RealmEngine';

/** Sends a TEXT packet to the client only — does NOT reach the server or other players. Autonexus-style local notice. */
function sendClientChatNotification(deps: BridgeDeps, message: string, sender: string): void {
  const c = deps.clientRef.current;
  if (!c?.connected) return;
  const pkt = deps.proxy.packetFactory.createByName('TEXT');
  pkt.data = {
    name: sender,
    objectId: -1,
    numStars: -1,
    bubbleTime: 0,
    recipient: '',
    text: message,
    cleanText: message,
    isSupporter: false,
    starBg: 0,
  };
  pkt.modified = true;
  c.sendToClient(pkt);
}

/** Build the `PLAYERTEXT.text` wire string for a given channel. RotMG uses `/` prefixes for non-say channels. */
function buildPlayerTextLine(message: string, channel: ChatChannel, recipient?: string): string | null {
  const body = String(message ?? '');
  switch (channel) {
    case 'say':
    case 'unknown':
      return body;
    case 'yell':
      return `/yell ${body}`;
    case 'party':
      return `/party ${body}`;
    case 'guild':
      return `/guild ${body}`;
    case 'tell': {
      const to = (recipient ?? '').trim();
      if (!to) return null;
      return `/tell ${to} ${body}`;
    }
    case 'global':
    case 'system':
      return null;
    default:
      return body;
  }
}

/** Send a PLAYERTEXT packet to the server (real chat). Returns true if dispatched. */
function sendServerChat(deps: BridgeDeps, message: string, channel: ChatChannel, recipient?: string): boolean {
  const c = deps.clientRef.current;
  if (!c?.connected) {
    Logger.warn('ScriptChat', `send(${channel}): not connected`);
    return false;
  }
  const line = buildPlayerTextLine(message, channel, recipient);
  if (line === null) {
    Logger.warn('ScriptChat', `send(${channel}): channel not supported for outgoing chat`);
    return false;
  }
  try {
    const pkt = deps.proxy.packetFactory.createByName('PLAYERTEXT');
    pkt.data = { text: line };
    pkt.modified = true;
    c.sendToServer(pkt);
    return true;
  } catch (err) {
    Logger.warn('ScriptChat', `send(${channel}) failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Test whether a TEXT packet should be filtered (dropped before reaching the client).
 * Returns true if any active rule matches both the word list and the star threshold.
 */
function shouldFilterTextPacket(data: Record<string, unknown>): boolean {
  if (filterRules.length === 0) return false;
  const text = String(data.cleanText ?? data.text ?? '').toLowerCase();
  const stars = typeof data.numStars === 'number' ? data.numStars : null;
  for (const rule of filterRules) {
    const wordHit = rule.words.some((w) => text.includes(w));
    if (!wordHit) continue;
    if (rule.minStars !== null && stars !== null && stars >= rule.minStars) continue;
    return true;
  }
  return false;
}

function ensureTextFilterHook(deps: BridgeDeps): void {
  if (textFilterHookRegistered) return;
  textFilterHookRegistered = true;
  deps.proxy.hookPacket('TEXT', (_client, packet) => {
    if (!packet.isDefined || !packet.data) return;
    if (shouldFilterTextPacket(packet.data as Record<string, unknown>)) {
      packet.send = false;
    }
  });
}

/** Call when a server chat line is parsed (e.g. TEXT packet) so listeners run. */
export function notifyChatListeners(event: ChatEvent): void {
  const snapshot = handlers.slice();
  for (const h of snapshot) {
    try {
      h(event);
    } catch {
      // ignore handler errors
    }
  }
}

export function install(deps: BridgeDeps): void {
  if (!textHookRegistered) {
    textHookRegistered = true;
    deps.proxy.hookPacket('TEXT', onTextPacket);
    deps.proxy.hookPacket('PLAYERTEXT', onPlayerTextPacket);
  }
  if (!playertextBlockHookRegistered) {
    playertextBlockHookRegistered = true;
    deps.proxy.hookPacket('PLAYERTEXT', onOutgoingPlayertextBlock, undefined, true);
  }

  ensureTextFilterHook(deps);

  chat.onMessage = (handler) => {
    handlers.push(handler);
    return () => {
      const i = handlers.indexOf(handler);
      if (i !== -1) handlers.splice(i, 1);
    };
  };

  chat.onMessageFrom = (playerName, handler) =>
    chat.onMessage((e) => {
      if (e.sender === playerName) handler(e);
    });

  chat.onMessageContaining = (match, handler) =>
    chat.onMessage((e) => {
      const hit = typeof match === 'string' ? e.message.includes(match) : match.test(e.message);
      if (hit) handler(e);
    });

  chat.onChannelMessage = (channel, handler) =>
    chat.onMessage((e) => {
      if (e.channel === channel) handler(e);
    });

  chat.onWhisper = (handler) =>
    chat.onMessage((e) => {
      if (e.channel === 'tell') handler(e);
    });

  chat.onSystemMessage = (handler) =>
    chat.onMessage((e) => {
      if (e.channel === 'system') handler(e);
    });

  chat.send = (message, channel = 'say') => {
    if (channel === 'system') {
      sendClientChatNotification(deps, String(message ?? ''), DEFAULT_NOTIFICATION_SENDER);
      return;
    }
    if (channel === 'tell') {
      Logger.warn('ScriptChat', 'send(tell): use chat.tell(playerName, message) — tell needs a recipient');
      return;
    }
    sendServerChat(deps, String(message ?? ''), channel);
  };

  chat.say = (msg) => { sendServerChat(deps, String(msg ?? ''), 'say'); };
  chat.yell = (msg) => { sendServerChat(deps, String(msg ?? ''), 'yell'); };
  chat.party = (msg) => { sendServerChat(deps, String(msg ?? ''), 'party'); };
  chat.guild = (msg) => { sendServerChat(deps, String(msg ?? ''), 'guild'); };
  chat.tell = (playerName, msg) => {
    sendServerChat(deps, String(msg ?? ''), 'tell', String(playerName ?? ''));
  };

  /**
   * Filter incoming chat — drops server TEXT packets before they reach the client.
   *
   * @param words  A word or list of words; any match triggers the filter.
   *               You can pass a pre-built array: `const spam = ['buy','sell','wtb']; chat.filter(spam)`
   * @param minStars  Optional star threshold. When provided, messages are only filtered if
   *                  the sender has **fewer than** this many stars. e.g. `chat.filter(spam, 10)`
   *                  keeps messages from 10-star+ players unfiltered.
   * @returns  An unsubscribe function — call it to remove this filter.
   *
   * @example
   * // Block any message containing trade spam from low-star accounts
   * const spamWords = ['buying', 'selling', 'wtb', 'wts', 'wtt'];
   * const unsub = chat.filter(spamWords, 10);
   *
   * // Remove the filter later
   * unsub();
   */
  (chat as unknown as Record<string, unknown>).filter = (
    words: string | string[],
    minStars?: number,
  ): (() => void) => {
    const wordList = (Array.isArray(words) ? words : [words])
      .map((w) => String(w).toLowerCase().trim())
      .filter((w) => w.length > 0);

    if (wordList.length === 0) {
      Logger.warn('ScriptChat', 'chat.filter: empty word list — no filter added');
      return () => {};
    }

    const rule: ChatFilterRule = {
      words: wordList,
      minStars: typeof minStars === 'number' && Number.isFinite(minStars) ? Math.trunc(minStars) : null,
    };
    filterRules.push(rule);

    return () => {
      const i = filterRules.indexOf(rule);
      if (i !== -1) filterRules.splice(i, 1);
    };
  };

  /**
   * Client-only local notification (autonexus / `PluginContext.sendNotification` pattern).
   * Fakes a server TEXT line so the user sees a chat entry; nothing reaches the server or other players.
   */
  (chat as unknown as Record<string, unknown>).notify = (message: string, sender?: string) => {
    const name = (sender ?? '').trim() || DEFAULT_NOTIFICATION_SENDER;
    sendClientChatNotification(deps, String(message ?? ''), name);
  };

  chat.blockOutgoing = (mode: ChatOutgoingBlockMode, ...patterns: string[]): (() => void) => {
    const needles = patterns
      .map((p) => String(p ?? '').trim().toLowerCase())
      .filter((n) => n.length > 0);
    if (needles.length === 0) {
      Logger.warn('ScriptChat', 'chat.blockOutgoing: no non-empty patterns — no rule added');
      return () => {};
    }
    if (mode !== 'equals' && mode !== 'contains') {
      Logger.warn('ScriptChat', `chat.blockOutgoing: invalid mode "${mode}" — use 'equals' or 'contains'`);
      return () => {};
    }
    const rule: OutgoingBlockRule = { mode, needles };
    outgoingBlockRules.push(rule);
    return () => {
      const i = outgoingBlockRules.indexOf(rule);
      if (i !== -1) outgoingBlockRules.splice(i, 1);
    };
  };
}
