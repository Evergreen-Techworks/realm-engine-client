import { registerClientHook } from '../core/hooks.js';

/** Register a library method for a lifecycle event emitted by Client. */
export function ClientHook(event: string): MethodDecorator {
  return (target, key) => {
    registerClientHook({
      target: target.constructor.name,
      method: key.toString(),
      event,
    });
  };
}
