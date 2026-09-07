import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameDataLoader } from '../GameDataLoader.js';
it('classifies purple and white boss markers, excluding blue bosses and minibosses regardless of HP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-markers-'));
  try {
    const path = join(dir, 'objects.xml');
    writeFileSync(path, `<Objects>
      <Object type="0x1" id="Event"><Class>Character</Class><MinimapIcon piece="Boss"/><Color>0x8F04A8</Color></Object>
      <Object type="0x2" id="Sentry"><Class>Character</Class><MinimapIcon piece="Boss"/><Color>0x1B006D</Color></Object>
      <Object type="0x3" id="Mini"><Class>Character</Class><Quest/><MaxHitPoints>300000</MaxHitPoints><MinimapIcon piece="Miniboss"/><Color>0xD50065</Color></Object>
      <Object type="0x4" id="Blue"><Class>Character</Class><MinimapIcon piece="Boss"/><Color>0x0077FF</Color></Object>
      <Object type="0x5" id="White"><Class>Character</Class><MinimapIcon piece="Boss"/><Color>0xFFFFFF</Color></Object>
      <Object type="0x6" id="Shrine"><Class>Character</Class><MinimapIcon piece="Boss"/><Color>0xD6D6BF</Color></Object>
      <Object type="0x7" id="Untinted"><Class>Character</Class><MinimapIcon piece="Boss"/></Object>
      <Object type="0x8" id="WhiteMini"><Class>Character</Class><MinimapIcon piece="Miniboss"/><Color>0xFFFFFF</Color></Object>
      <Object type="0x9" id="Plain"><Class>Character</Class><Enemy/></Object>
      </Objects>`);
    const data = new GameDataLoader(); data.load(path);
    expect([1,2,3,4,5,6,7,8,9].map(t => data.getObject(t)?.isEventBoss)).toEqual([true,true,false,false,true,true,true,false,false]);
  } finally { rmSync(dir, { recursive: true }); }
});
