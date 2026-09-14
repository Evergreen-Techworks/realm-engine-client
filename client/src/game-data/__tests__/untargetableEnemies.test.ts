import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameDataLoader } from '../GameDataLoader.js';

// Rows modelled on objects.xml (RE_ASSETS/data, game 86ad651b). Of 787 enemy types drawn
// with the `invisible` texture, 583 carry <Invincible/>; most of the rest are real bosses
// drawn through AltTexture/Presentation/Animation (e.g. 0x3327 NMR Boss Adept, 0xb174 Feargus).
it('flags <Invincible/> enemies and invisible helpers that have no body to hit, but not bosses drawn another way', () => {
  const dir = mkdtempSync(join(tmpdir(), 'untargetable-'));
  try {
    const path = join(dir, 'objects.xml');
    writeFileSync(path, `<Objects>
      <Object type="0x0e36" id="Ghost Lanturn On"><Class>Character</Class><Enemy/><Invincible/><Texture><File>lofiObj3</File><Index>0</Index></Texture></Object>
      <Object type="0x1e18" id="Treasure Dropper"><Class>Character</Class><Enemy/><Texture><File>invisible</File><Index>0</Index></Texture></Object>
      <Object type="0x2018" id="Hook Helper"><Class>Character</Class><Enemy/><Texture><File>invisible</File><Index>0</Index></Texture><Size>0</Size><MaxHitPoints>100000</MaxHitPoints></Object>
      <Object type="0x3327" id="NMR Boss Adept"><Class>Character</Class><Enemy/><Texture><File>invisible</File><Index>0</Index></Texture><AltTexture id="1"><Texture><File>chars</File><Index>1</Index></Texture></AltTexture><MaxHitPoints>100000</MaxHitPoints></Object>
      <Object type="0x6d97" id="md2 Explode"><Class>Character</Class><Enemy/><Texture><File>invisible</File><Index>0</Index></Texture><Size>200</Size><MaxHitPoints>20000</MaxHitPoints></Object>
      <Object type="0x559B" id="New Small Ghost"><Class>Character</Class><Enemy/><AnimatedTexture><File>Rookie_8x8</File><Index>3</Index></AnimatedTexture><MaxHitPoints>1000</MaxHitPoints></Object>
      </Objects>`);
    const data = new GameDataLoader(); data.load(path);
    const flags = (t: number) => [data.getObject(t)?.invincible, data.getObject(t)?.hiddenHelper];
    expect(flags(0x0e36)).toEqual([true, false]);
    expect(flags(0x1e18)).toEqual([false, true]);   // invisible, no HP
    expect(flags(0x2018)).toEqual([false, true]);   // invisible, Size 0
    expect(flags(0x3327)).toEqual([false, false]);  // boss drawn by AltTexture
    expect(flags(0x6d97)).toEqual([false, false]);  // invisible with HP and a body: not provably a helper
    expect(flags(0x559B)).toEqual([false, false]);
  } finally { rmSync(dir, { recursive: true }); }
});
