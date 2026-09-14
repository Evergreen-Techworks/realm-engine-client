// Types for packet-keys.mjs (plain node module shared by the build scripts).
export type PacketDirection = 'client' | 'server';

export declare const DIRECTIONS: PacketDirection[];

export declare function parsePacketKey(key: string): { id: number; direction: PacketDirection | null } | null;

export declare function packetKey(id: number, direction: PacketDirection, shared: boolean): string;

export declare function packetEntries<T extends { direction: string }>(
  packets: Record<string, T>,
): Array<{ key: string; id: number; direction: string; packet: T }>;

export declare function keyPackets<T extends { direction: string; name?: string }>(
  list: Array<{ id: number; packet: T }>,
): Record<string, T>;

export declare function packetKeyProblems(packets: Record<string, unknown>): string[];
