import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Packet } from '@re-headless/protocol';
import { Logger, LogLevel } from '../services/logger.js';
import { getClientHooks, getLibraries, getPacketHooks } from './hooks.js';
import type { Client } from './client.js';

export class LibraryManager {
  private libs: any[] = [];
  private packetHookIndex: Map<string, Array<{ lib: any; method: string }>> = new Map();
  private clientHookIndex: Map<string, Array<{ lib: any; method: string }>> = new Map();

  constructor(readonly root: string) {}

  async loadPlugins(pluginFolder: string): Promise<void> {
    const abs = path.isAbsolute(pluginFolder) ? pluginFolder : path.join(this.root, pluginFolder);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(abs);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        Logger.log('LibraryManager', `No plugins folder found at ${abs}`, LogLevel.Warning);
        return;
      }
      throw err;
    }

    for (const file of entries) {
      if (!/\.(mjs|js)$/.test(file)) continue;
      const url = pathToFileURL(path.join(abs, file)).toString();
      Logger.log('LibraryManager', `Importing ${url}`, LogLevel.Info);
      await import(url);
    }

    // Instantiate libraries.
    this.libs = [];
    for (const { ctor, info } of getLibraries()) {
      if (info.enabled === false) continue;
      try {
        this.libs.push(new ctor());
      } catch (err: any) {
        Logger.log('LibraryManager', `Failed to init lib ${info.name}: ${err?.message ?? err}`, LogLevel.Error);
      }
    }

    // Index packet hooks.
    this.packetHookIndex.clear();
    for (const hook of getPacketHooks()) {
      const list = this.packetHookIndex.get(hook.packet) ?? [];
      for (const lib of this.libs) {
        if (lib?.constructor?.name === hook.target && typeof lib[hook.method] === 'function') {
          list.push({ lib, method: hook.method });
        }
      }
      if (list.length) this.packetHookIndex.set(hook.packet, list);
    }

    this.clientHookIndex.clear();
    for (const hook of getClientHooks()) {
      const list = this.clientHookIndex.get(hook.event) ?? [];
      for (const lib of this.libs) {
        if (lib?.constructor?.name === hook.target && typeof lib[hook.method] === 'function') {
          list.push({ lib, method: hook.method });
        }
      }
      if (list.length) this.clientHookIndex.set(hook.event, list);
    }
  }

  attachClient(client: Client): void {
    for (const [event, hooks] of this.clientHookIndex) {
      client.addListener(event, (...args: unknown[]) => {
        for (const h of hooks) {
          try {
            h.lib[h.method](client, ...args);
          } catch (err: any) {
            Logger.log('LibraryManager', `Hook error ${h.lib.constructor.name}.${h.method}: ${err?.message ?? err}`, LogLevel.Error);
          }
        }
      });
    }
  }

  dispatchPacket(client: Client, packet: Packet): void {
    const list = this.packetHookIndex.get(packet.type);
    if (!list) return;
    for (const h of list) {
      try {
        h.lib[h.method](client, packet);
      } catch (err: any) {
        Logger.log('LibraryManager', `Hook error ${h.lib.constructor.name}.${h.method}: ${err?.message ?? err}`, LogLevel.Error);
      }
    }
  }
}
