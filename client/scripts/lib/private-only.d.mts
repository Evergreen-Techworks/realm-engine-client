// Types for private-only.mjs (plain node module shared with build-prod.mjs).
export interface PrivateOnlyManifest {
  marker: string;
  paths: string[];
}

export declare function validatePrivateOnlyManifest(raw: unknown, root: string): PrivateOnlyManifest;

export declare function readPrivateOnlyManifest(manifestPath: string, root: string): PrivateOnlyManifest | null;

export declare function pluginKeyForPath(manifestPath: string): string | null;

export declare function excludedPluginKeys(manifest: PrivateOnlyManifest | null, isPrivateBuild: boolean): Set<string>;

export declare function scanForMarker(dir: string, marker: string): string[];
