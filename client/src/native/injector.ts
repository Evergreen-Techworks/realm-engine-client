import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { Logger } from '../util/Logger.js';

export interface InjectResult {
  ok: boolean;
  error?: string;
}

export function injectDll(
  pid: number,
  dllPath: string,
  injectorPath: string,
): Promise<InjectResult> {
  return new Promise((resolve) => {
    if (!existsSync(injectorPath)) {
      resolve({ ok: false, error: `Injector not found: ${injectorPath}` });
      return;
    }
    if (!existsSync(dllPath)) {
      resolve({ ok: false, error: `DLL not found: ${dllPath}` });
      return;
    }

    Logger.log('Injector', `Injecting ${dllPath} into PID ${pid}...`);

    execFile(
      injectorPath,
      [String(pid), dllPath],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          const msg = `Injector process failed: ${err.message}`;
          Logger.error('Injector', msg);
          resolve({ ok: false, error: msg });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim()) as InjectResult;
          if (result.ok) {
            Logger.log('Injector', `DLL injected into PID ${pid}.`);
          } else {
            Logger.error('Injector', `Injection failed: ${result.error}`);
          }
          resolve(result);
        } catch {
          const msg = `Bad injector output: ${stdout.slice(0, 200)}`;
          Logger.error('Injector', msg);
          resolve({ ok: false, error: msg });
        }
      },
    );
  });
}
