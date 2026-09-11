import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameDataLoader } from '../GameDataLoader.js';

describe('cosmetic catalog', () => {
  it('parses typed cosmetics and emits stable dashboard entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cosmetic-catalog-'));
    try {
      const path = join(dir, 'objects.xml');
      writeFileSync(path, `<Objects>
        <Object type="0x1001" id="Knight Skin">
          <Class>Skin</Class><DisplayId>Golden Knight</DisplayId>
          <PlayerClassType>0x0301</PlayerClassType>
          <AnimatedTexture><File>players</File><Index>7</Index></AnimatedTexture>
        </Object>
        <Object type="0x1002" id="Blue Dye">
          <Class>Dye</Class><DisplayId>{dyes.Alice_Blue_Clothing_Dye}</DisplayId>
          <Tex1>0x01F0F8FF</Tex1>
          <Texture><File>lofiObj</File><Index>12</Index></Texture>
        </Object>
        <Object type="0x1007" id="Stitch Cloth">
          <Class>Dye</Class><Tex2>0x0A000005</Tex2>
          <Texture><File>lofiObj3</File><Index>29</Index></Texture>
        </Object>
        <Object type="0x1008" id="Clothing Dye Remover">
          <Class>Dye</Class><Tex1>0xffffffff</Tex1>
          <Texture><File>lofiObj3</File><Index>1465</Index></Texture>
        </Object>
        <Object type="0x1003" id="Pet Rock Skin">
          <Class>PetSkin</Class><PetSkin/><DisplayId>Pet Rock</DisplayId>
          <AnimatedTexture><File>petsDivine</File><Index>5</Index></AnimatedTexture>
        </Object>
        <Object type="0x1009" id="Pet Rock">
          <Class>Pet</Class><Pet/><DefaultSkin>Pet Rock Skin</DefaultSkin>
          <Texture><File>lofiObj2</File><Index>0x32</Index></Texture>
        </Object>
        <Object type="0x100a" id="Pet Rock Egg">
          <Class>Equipment</Class><Item/><PetSkin>Pet Rock Skin</PetSkin>
          <Texture><File>lofiObj2</File><Index>320</Index></Texture>
        </Object>
        <Object type="0x1004" id="Royal Gravestone">
          <Class>GameObject</Class><Group>Gravestones</Group>
          <Texture><File>lofiObj2</File><Index>3</Index></Texture>
        </Object>
        <Object type="0x1005" id="Champion Title">
          <Class>Title</Class><TitleType>Suffix</TitleType>
          <Texture><File>titles</File><Index>2</Index></Texture>
        </Object>
        <Object type="0x1006" id="Flame Entrance">
          <Class>Entrance</Class><Texture><File>entrances</File><Index>9</Index></Texture>
        </Object>
        <Object type="0x2000" id="Ordinary"><Class>Equipment</Class></Object>
      </Objects>`);

      const data = new GameDataLoader();
      data.load(path);
      const catalog = data.getCosmeticCatalog();

      expect(catalog).toHaveLength(7);
      expect(catalog.find((entry) => entry.kind === 'skin')).toEqual({
        id: 'skin:1001',
        label: 'Golden Knight',
        kind: 'skin',
        classType: 0x301,
        values: { objectType: 0x1001, playerClassType: 0x301 },
        iconUrl: '/api/wiki-texture-file?file=players&index=7',
      });

      // A solid dye previews as its colour; the item's own sprite is a shared vial.
      expect(catalog.find((entry) => entry.id === 'dye:1002')).toEqual({
        id: 'dye:1002',
        label: 'Alice Blue Clothing Dye',
        kind: 'dye',
        values: { objectType: 0x1002, tex1: 0x01f0f8ff },
        swatchColor: '#f0f8ff',
      });
      // A cloth dye previews as the indexed sprite from its textile sheet.
      expect(catalog.find((entry) => entry.id === 'dye:1007')).toEqual({
        id: 'dye:1007',
        label: 'Stitch Cloth',
        kind: 'dye',
        values: { objectType: 0x1007, tex2: 0x0a000005 },
        iconUrl: '/api/wiki-texture-file?file=textile10x10&index=5',
      });
      expect(catalog.find((entry) => entry.id === 'dye:1008')).toBeUndefined();

      // Pet appearance lives on the PetSkin object; the Pet base object and the egg
      // item that merely references a skin are both excluded.
      expect(catalog.filter((entry) => entry.kind === 'pet')).toEqual([{
        id: 'pet:1003',
        label: 'Pet Rock',
        kind: 'pet',
        values: { objectType: 0x1003 },
        iconUrl: '/api/wiki-texture-file?file=petsDivine&index=5',
      }]);

      expect(catalog.find((entry) => entry.kind === 'title')).toMatchObject({
        id: 'title:1005',
        values: { objectType: 0x1005, titleSlot: 1 },
      });
      expect(catalog.map((entry) => entry.kind).sort()).toEqual([
        'dye', 'dye', 'entrance', 'gravestone', 'pet', 'skin', 'title',
      ]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('clears cosmetics removed by a subsequent XML load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cosmetic-reload-'));
    try {
      const path = join(dir, 'objects.xml');
      const data = new GameDataLoader();
      let reloads = 0;
      data.onReload(() => { reloads += 1; });
      writeFileSync(path, '<Objects><Object type="0x1" id="Pet"><Class>PetSkin</Class></Object></Objects>');
      data.load(path);
      expect(data.getCosmeticCatalog()).toHaveLength(1);

      writeFileSync(path, '<Objects><Object type="0x2" id="Item"><Class>Equipment</Class></Object></Objects>');
      data.load(path);
      expect(data.getCosmeticCatalog()).toEqual([]);
      expect(reloads).toBe(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
