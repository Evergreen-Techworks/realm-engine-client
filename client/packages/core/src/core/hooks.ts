export type PacketHookInfo = {
  target: string;
  method: string;
  packet: string;
};

export type ClientHookInfo = {
  target: string;
  method: string;
  event: string;
};

export type LibraryInfo = {
  name: string;
  enabled?: boolean;
};

const packetHooks: PacketHookInfo[] = [];
const clientHooks: ClientHookInfo[] = [];
const libraries: Array<{ ctor: new (...args: any[]) => any; info: LibraryInfo }> = [];

export function registerPacketHook(h: PacketHookInfo): void {
  packetHooks.push(h);
}

export function getPacketHooks(): PacketHookInfo[] {
  return [...packetHooks];
}

export function registerClientHook(h: ClientHookInfo): void {
  clientHooks.push(h);
}

export function getClientHooks(): ClientHookInfo[] {
  return [...clientHooks];
}

export function registerLibrary(ctor: new (...args: any[]) => any, info: LibraryInfo): void {
  libraries.push({ ctor, info });
}

export function getLibraries(): Array<{ ctor: new (...args: any[]) => any; info: LibraryInfo }> {
  return [...libraries];
}
