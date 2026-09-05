import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Logger } from '../util/Logger.js';

const EXALT_EXE = 'RotMG Exalt.exe';

export class ExaltFinder {
  /**
   * Auto-detect the RotMG Exalt installation directory.
   * Search order:
   *   1. ROTMG_PATH environment variable
   *   2. AppData\Local\RealmOfTheMadGod\Production (actual exe location)
   *   3. Documents\RealmOfTheMadGod\Production (legacy/alt location)
   *   4. Steam common apps paths
   */
  static find(): string | null {
    const all = ExaltFinder.findAll();
    if (all.length > 0) {
      Logger.log('ExaltFinder', `Found Exalt at: ${all[0]}`);
      return all[0];
    }
    Logger.warn('ExaltFinder', 'Could not auto-detect Exalt installation.');
    Logger.warn('ExaltFinder', 'Set the ROTMG_PATH environment variable to your Exalt directory.');
    Logger.warn('ExaltFinder', `Expected to find ${EXALT_EXE} in the directory.`);
    return null;
  }

  /**
   * Every valid Exalt install on this machine, in priority order. A user can
   * have BOTH a Deca-launcher install (AppData/Documents) and a Steam install
   * at once — `find()` returns only the first, but for hands-off "launch from
   * Steam" we want the hooks in every copy so it works no matter which the user
   * starts. Deduped; order matters (ROTMG_PATH → AppData → Documents → Steam).
   */
  static findAll(): string[] {
    const home = homedir();
    const appDataLocal = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');

    const candidates = [
      // 1. Environment variable override
      process.env.ROTMG_PATH,
      // 2. AppData\Local — where the Deca-launcher exe actually runs from
      join(appDataLocal, 'RealmOfTheMadGod', 'Production'),
      // 3. Documents folder (legacy/alt location)
      join(home, 'Documents', 'RealmOfTheMadGod', 'Production'),
      // 4. Standalone custom / root locations
      'C:\\Program Files\\RealmOfTheMadGod\\Production',
      'C:\\Program Files (x86)\\RealmOfTheMadGod\\Production',
      'C:\\RealmOfTheMadGod\\Production',
      'C:\\Games\\Realm of the Mad God',
      'C:\\Games\\RotMG Exalt',
      // 5. Steam common apps + LoginGUI-style "Realm of the Mad God" and C:\Games
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\RotMG Exalt',
      'C:\\Program Files\\Steam\\steamapps\\common\\RotMG Exalt',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Realm of the Mad God',
      'C:\\Program Files\\Steam\\steamapps\\common\\Realm of the Mad God',
      'D:\\Steam\\steamapps\\common\\RotMG Exalt',
      'D:\\SteamLibrary\\steamapps\\common\\RotMG Exalt',
      'E:\\Steam\\steamapps\\common\\RotMG Exalt',
      'E:\\SteamLibrary\\steamapps\\common\\RotMG Exalt',
      // 6. Linux / Proton default paths mapped under Z:\
      ...(process.env.USER || process.env.USERNAME
        ? [
            // Standalone Linux paths
            `Z:\\home\\${process.env.USER || process.env.USERNAME}\\Games\\RealmOfTheMadGod\\Production`,
            `Z:\\home\\${process.env.USER || process.env.USERNAME}\\RealmOfTheMadGod\\Production`,
            `Z:\\home\\${process.env.USER || process.env.USERNAME}\\.local\\share\\RealmOfTheMadGod\\Production`,
            // Steam Linux / Steam Deck paths
            `Z:\\home\\${process.env.USER || process.env.USERNAME}\\.local\\share\\Steam\\steamapps\\common\\RotMG Exalt`,
            `Z:\\home\\${process.env.USER || process.env.USERNAME}\\.local\\share\\Steam\\steamapps\\common\\Realm of the Mad God Exalt`,
            `Z:\\home\\${process.env.USER || process.env.USERNAME}\\.steam\\steam\\steamapps\\common\\RotMG Exalt`,
            `Z:\\home\\${process.env.USER || process.env.USERNAME}\\.steam\\steam\\steamapps\\common\\Realm of the Mad God Exalt`,
            `Z:\\home\\${process.env.USER || process.env.USERNAME}\\.steam\\root\\steamapps\\common\\RotMG Exalt`,
            `Z:\\home\\${process.env.USER || process.env.USERNAME}\\.var\\app\\com.valvesoftware.Steam\\.local\\share\\Steam\\steamapps\\common\\RotMG Exalt`,
            `Z:\\home\\${process.env.USER || process.env.USERNAME}\\.var\\app\\com.valvesoftware.Steam\\.local\\share\\Steam\\steamapps\\common\\Realm of the Mad God Exalt`,
          ]
        : []),
      // Steam Deck's conventional account name remains detectable even when
      // Wine does not forward USER/USERNAME into the Windows environment.
      'Z:\\home\\deck\\.local\\share\\Steam\\steamapps\\common\\RotMG Exalt',
      'Z:\\home\\deck\\.local\\share\\Steam\\steamapps\\common\\Realm of the Mad God Exalt',
    ];

    const found: string[] = [];
    for (const dir of candidates) {
      if (dir && ExaltFinder.isValidExaltDir(dir) && !found.includes(dir)) {
        found.push(dir);
      }
    }
    return found;
  }

  /** True when `dir` looks like a Steam library install (…/steamapps/common/…). */
  static isSteamInstall(dir: string): boolean {
    return /[\\/]steamapps[\\/]common[\\/]/i.test(String(dir || ''));
  }

  private static isValidExaltDir(dir: string): boolean {
    try {
      return existsSync(dir) && existsSync(join(dir, EXALT_EXE));
    } catch {
      return false;
    }
  }
}
