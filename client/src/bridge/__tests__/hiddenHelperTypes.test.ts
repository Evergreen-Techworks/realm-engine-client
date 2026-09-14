import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameDataLoader } from '../../game-data/GameDataLoader.js';
import { setDllFeatureSender } from '../DllFeatureBus.js';
import { InternalBridge } from '../InternalBridge.js';
import { BRIDGE } from '../contract.js';
import {
  attachHiddenHelperTypeSync,
  encodeTypeListMessages,
  MAX_FEATURE_TEXT_BYTES,
} from '../HiddenHelperTypes.js';

const KEY = 'enemyHiddenHelperTypes';

/**
 * Port of the DLL's parser, EnemyClassify::ApplyTypeListMessage + ParseTypeList
 * (internal/src/features/combat/enemytracker/EnemyClassify.h), plus the
 * truncation IpcJson::GetString applies before it (FeatureCommand::value is
 * char[4096]). Returns null where the DLL rejects the message and keeps its list.
 */
function applyNative(message: string, current: number[]): number[] | null {
  const value = message.slice(0, 4095);
  const append = value.startsWith('+');
  const text = append ? value.slice(1) : value;
  const parsed = append ? [...current] : [];
  for (const token of text.split(/[,;\s]+/).filter(Boolean)) {
    const hex = token.length > 2 && /^0[xX]/.test(token);
    const digits = hex ? token.slice(2) : token;
    if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return null;
    const n = parseInt(digits, hex ? 16 : 10);
    if (n > 0xffff) return null;
    parsed.push(n);
  }
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function applyAll(messages: string[], start: number[] = []): number[] {
  let list = start;
  for (const m of messages) {
    const next = applyNative(m, list);
    expect(next, `DLL rejects ${JSON.stringify(m.slice(0, 40))}`).not.toBeNull();
    list = next!;
  }
  return list;
}

/** objects.xml rows modelled on game 86ad651b. */
const HELPER_ROWS = `
  <Object type="0x1e18" id="Treasure Dropper"><Class>Character</Class><Enemy/><Texture><File>invisible</File><Index>0</Index></Texture></Object>
  <Object type="0x2018" id="Hook Helper"><Class>Character</Class><Enemy/><Texture><File>invisible</File><Index>0</Index></Texture><Size>0</Size><MaxHitPoints>100000</MaxHitPoints></Object>
  <Object type="0x86f3" id="World's Oyster Coral Spawner"><Class>Character</Class><Enemy/><Texture><File>invisible</File><Index>0</Index></Texture><Size>1</Size><MaxHitPoints>6000</MaxHitPoints></Object>
  <Object type="0x3327" id="NMR Boss Adept"><Class>Character</Class><Enemy/><Texture><File>invisible</File><Index>0</Index></Texture><AltTexture id="1"><Texture><File>chars</File><Index>1</Index></Texture></AltTexture><MaxHitPoints>100000</MaxHitPoints></Object>
  <Object type="0x559B" id="New Small Ghost"><Class>Character</Class><Enemy/><AnimatedTexture><File>Rookie_8x8</File><Index>3</Index></AnimatedTexture><MaxHitPoints>1000</MaxHitPoints></Object>
  <Object type="0x3df0" id="NMR Wall Players"><Class>GameObject</Class><Texture><File>invisible</File><Index>0</Index></Texture></Object>`;

/** The loader's own classification, read flag by flag: what native must end up holding. */
function loaderHelperEnemyTypes(data: GameDataLoader): number[] {
  return data.getAllObjects().filter((o) => o.isEnemy && o.hiddenHelper)
    .map((o) => o.type).sort((a, b) => a - b);
}

function helperEnemyRows(count: number, firstType = 0x4e20): string {
  let rows = '';
  for (let i = 0; i < count; i++) {
    rows += `<Object type="0x${(firstType + i).toString(16)}" id="Helper ${i}"><Class>Character</Class><Enemy/>`
      + '<Texture><File>invisible</File><Index>0</Index></Texture></Object>\n';
  }
  return rows;
}

let tempDirs: string[] = [];
function writeObjectsXml(rows: string, dir?: string): string {
  const d = dir ?? mkdtempSync(join(tmpdir(), 'hidden-helper-types-'));
  if (!dir) tempDirs.push(d);
  const path = join(d, 'objects.xml');
  writeFileSync(path, `<Objects>${rows}</Objects>`);
  return path;
}

afterEach(() => {
  setDllFeatureSender(null);
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

describe('encodeTypeListMessages', () => {
  it('writes sorted, unique decimal types separated by commas', () => {
    expect(encodeTypeListMessages([0x86f3, 0x2018, 0x1e18, 0x2018])).toEqual(['7704,8216,34547']);
  });

  it('sends one empty message for an empty list, which clears the DLL list', () => {
    expect(encodeTypeListMessages([])).toEqual(['']);
    expect(applyAll([''], [5, 6])).toEqual([]);
  });

  it('leaves out values the DLL would reject, which would drop the whole message', () => {
    expect(encodeTypeListMessages([Number.NaN, -1, 0x10000, 1.5, 5, 65535])).toEqual(['5,65535']);
  });

  it('keeps a list of exactly 4095 bytes in one message and splits at 4096', () => {
    const fiveDigit = Array.from({ length: 682 }, (_, i) => 10000 + i);   // 682 * 6 - 1 = 4091 bytes
    const exact = encodeTypeListMessages([100, ...fiveDigit]);             // "100," + 4091 = 4095
    expect(exact).toHaveLength(1);
    expect(exact[0]).toHaveLength(MAX_FEATURE_TEXT_BYTES);

    const over = encodeTypeListMessages([100, 101, ...fiveDigit]);         // 4099 bytes
    expect(over.length).toBeGreaterThan(1);
    expect(over[0].startsWith('+')).toBe(false);
    for (const m of over.slice(1)) expect(m.startsWith('+')).toBe(true);
    for (const m of over) expect(Buffer.byteLength(m, 'utf8')).toBeLessThanOrEqual(MAX_FEATURE_TEXT_BYTES);
    expect(applyAll(over)).toEqual([100, 101, ...fiveDigit]);
  });

  it('replaces, then appends, so a long list survives the DLL parser intact', () => {
    const types = Array.from({ length: 1500 }, (_, i) => 0x4e20 + i * 17);
    const messages = encodeTypeListMessages(types);
    expect(messages.length).toBeGreaterThanOrEqual(3);
    for (const m of messages) expect(Buffer.byteLength(m, 'utf8')).toBeLessThanOrEqual(MAX_FEATURE_TEXT_BYTES);
    // A stale list from an earlier game build is replaced, not merged.
    expect(applyAll(messages, [1, 2, 3])).toEqual(types);
  });
});

describe('attachHiddenHelperTypeSync', () => {
  function capture(): Array<[string, unknown]> {
    const sent: Array<[string, unknown]> = [];
    setDllFeatureSender((key, value) => { sent.push([key, value]); });
    return sent;
  }

  it('sends the loader\'s hidden-helper enemy types, in the DLL format, when attached', () => {
    const data = new GameDataLoader();
    data.load(writeObjectsXml(HELPER_ROWS));
    const sent = capture();

    attachHiddenHelperTypeSync(data, new EventEmitter());

    expect(sent).toEqual([[KEY, '7704,8216,34547']]);
    expect(applyAll(sent.map(([, v]) => String(v)))).toEqual(loaderHelperEnemyTypes(data));
    expect(loaderHelperEnemyTypes(data)).toEqual([0x1e18, 0x2018, 0x86f3]);
  });

  it('re-sends the list every time the DLL connects', () => {
    const data = new GameDataLoader();
    data.load(writeObjectsXml(HELPER_ROWS));
    const bridge = new EventEmitter();
    const sent = capture();
    attachHiddenHelperTypeSync(data, bridge);
    sent.length = 0;

    bridge.emit('authenticated');
    expect(sent).toEqual([[KEY, '7704,8216,34547']]);
    bridge.emit('authenticated');
    expect(sent).toHaveLength(2);
  });

  it('re-sends the new list when objects.xml reloads, and stops once detached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidden-helper-reload-'));
    tempDirs.push(dir);
    const data = new GameDataLoader();
    data.load(writeObjectsXml(HELPER_ROWS, dir));
    const bridge = new EventEmitter();
    const sent = capture();
    const detach = attachHiddenHelperTypeSync(data, bridge);
    sent.length = 0;

    // A game update removes the Treasure Dropper and adds another helper.
    data.load(writeObjectsXml(
      HELPER_ROWS.replace(/<Object type="0x1e18"[^\n]*\n/, '') + helperEnemyRows(1, 0x9000), dir));
    expect(sent).toEqual([[KEY, '8216,34547,36864']]);
    expect(applyAll(sent.map(([, v]) => String(v)), [0x1e18])).toEqual(loaderHelperEnemyTypes(data));

    detach();
    data.load(writeObjectsXml(HELPER_ROWS, dir));
    bridge.emit('authenticated');
    expect(sent).toHaveLength(1);
  });
});

describe('hidden-helper types on the real DLL pipe', () => {
  type FakeSocket = { destroyed: boolean; frames: Buffer[]; write(b: Buffer): boolean; destroy(): void };
  type BridgeInternals = { socket: FakeSocket | null; handleMessage(msg: unknown): void; disconnect(): void };

  function fakeSocket(): FakeSocket {
    return {
      destroyed: false,
      frames: [],
      write(b) { this.frames.push(b); return true; },
      destroy() { this.destroyed = true; },
    };
  }

  /** The enemyHiddenHelperTypes values written to one pipe session, in order. */
  function helperValues(sock: FakeSocket): string[] {
    const out: string[] = [];
    for (const frame of sock.frames) {
      expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
      const msg = JSON.parse(frame.subarray(4).toString('utf8'));
      if (msg.type === 'setFeature' && msg.key === KEY) {
        expect(msg.valueType).toBe('s');
        out.push(msg.value);
      }
    }
    return out;
  }

  function connect(bridge: InternalBridge): FakeSocket {
    const internals = bridge as unknown as BridgeInternals;
    const sock = fakeSocket();
    internals.socket = sock;
    internals.handleMessage({ type: 'hello', version: BRIDGE.PROTOCOL_VERSION, protocol: BRIDGE.PROTOCOL_TAG });
    return sock;
  }

  it('gives a freshly injected DLL the whole list on every connect, even when it spans several messages', () => {
    const data = new GameDataLoader();
    data.load(writeObjectsXml(helperEnemyRows(900)));   // 900 five-digit types: two messages
    const expected = loaderHelperEnemyTypes(data);
    expect(expected).toHaveLength(900);

    const bridge = new InternalBridge('test');
    setDllFeatureSender((key, value) => bridge.setFeature(key, value));
    try {
      attachHiddenHelperTypeSync(data, bridge);   // before the DLL connects, as index.ts does

      const first = connect(bridge);
      expect(helperValues(first).length).toBeGreaterThan(1);
      expect(applyAll(helperValues(first))).toEqual(expected);

      // The DLL drops the pipe and a re-injected DLL (empty list) connects.
      (bridge as unknown as BridgeInternals).disconnect();
      const second = connect(bridge);
      expect(applyAll(helperValues(second))).toEqual(expected);
      // The same DLL reconnecting, still holding the list, ends up with the same list.
      expect(applyAll(helperValues(second), expected)).toEqual(expected);
    } finally {
      bridge.stop();
    }
  });
});
