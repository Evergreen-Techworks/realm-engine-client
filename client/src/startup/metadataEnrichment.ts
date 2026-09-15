import type { EnsureRotmgMetadataXmlResult } from '../util/ensureRotmgMetadataXml.js';

export interface MetadataStatus {
  state: 'loading' | 'available' | 'unavailable' | 'cancelled';
  failed: string[];
}

export async function startMetadataEnrichment(options: {
  run(signal: AbortSignal): Promise<EnsureRotmgMetadataXmlResult>;
  publish(status: MetadataStatus): void;
  signal: AbortSignal;
}): Promise<void> {
  let finished = false;
  const finish = (status: MetadataStatus) => {
    if (finished) return;
    finished = true;
    options.publish(status);
  };
  const cancel = () => finish({ state: 'cancelled', failed: [] });
  if (options.signal.aborted) { cancel(); return; }
  options.signal.addEventListener('abort', cancel, { once: true });
  try {
    options.publish({ state: 'loading', failed: [] });
    if (options.signal.aborted) return;
    const result = await options.run(options.signal);
    if (options.signal.aborted) cancel();
    else finish({ state: result.ok ? 'available' : 'unavailable', failed: [...result.failed] });
  } catch {
    if (options.signal.aborted) cancel();
    else finish({ state: 'unavailable', failed: ['enchantments.xml'] });
  } finally {
    options.signal.removeEventListener('abort', cancel);
  }
}
