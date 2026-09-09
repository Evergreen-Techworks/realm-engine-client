import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import { Logger } from '../util/Logger.js';

export type LovenseConfig = {
  enabled: boolean;
  endpoint: string;
  toyId?: string;
  minStrength: number;
  maxStrength: number;
  damagePercentForMaxStrength: number;
  pulseSeconds: number;
  cooldownMs: number;
};

export type LovenseFunctionCommand = {
  command: 'Function';
  action: string;
  timeSec: number;
  apiVer: 1;
  toy?: string;
};

type DamageState = {
  ownerObjectId: number;
  previousHealth: number;
  lastSentAt: number;
};

type CommandSender = (command: LovenseFunctionCommand) => Promise<void>;

const DEFAULT_CONFIG: LovenseConfig = {
  enabled: false,
  endpoint: 'https://127-0-0-1.lovense.club:30010/command',
  minStrength: 3,
  maxStrength: 20,
  damagePercentForMaxStrength: 35,
  pulseSeconds: 2,
  cooldownMs: 250,
};

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseLovenseConfig(value: unknown): LovenseConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : DEFAULT_CONFIG.endpoint;
  let validEndpoint = false;
  try {
    const url = new URL(endpoint);
    validEndpoint = (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === '/command';
  } catch {
    validEndpoint = false;
  }

  const minStrength = Math.round(clamp(finiteNumber(raw.minStrength, DEFAULT_CONFIG.minStrength), 1, 20));
  const maxStrength = Math.round(clamp(finiteNumber(raw.maxStrength, DEFAULT_CONFIG.maxStrength), minStrength, 20));
  const toyId = typeof raw.toyId === 'string' ? raw.toyId.trim() : '';

  return {
    enabled: raw.enabled === true && validEndpoint,
    endpoint: validEndpoint ? endpoint : DEFAULT_CONFIG.endpoint,
    ...(toyId ? { toyId } : {}),
    minStrength,
    maxStrength,
    damagePercentForMaxStrength: clamp(
      finiteNumber(raw.damagePercentForMaxStrength, DEFAULT_CONFIG.damagePercentForMaxStrength),
      1,
      100,
    ),
    pulseSeconds: clamp(finiteNumber(raw.pulseSeconds, DEFAULT_CONFIG.pulseSeconds), 2, 60),
    cooldownMs: Math.round(clamp(finiteNumber(raw.cooldownMs, DEFAULT_CONFIG.cooldownMs), 0, 60_000)),
  };
}

export function vibrationStrengthForDamage(
  damage: number,
  maxHealth: number,
  config: Pick<LovenseConfig, 'minStrength' | 'maxStrength' | 'damagePercentForMaxStrength'>,
): number {
  if (!Number.isFinite(damage) || damage <= 0 || !Number.isFinite(maxHealth) || maxHealth <= 0) return 0;
  const damagePercent = damage / maxHealth * 100;
  const ratio = clamp(damagePercent / config.damagePercentForMaxStrength, 0, 1);
  const scaled = config.minStrength + ratio * (config.maxStrength - config.minStrength);
  return Math.round(clamp(scaled, config.minStrength, config.maxStrength));
}

/** Converts confirmed local-player HP drops into Lovense local API commands. */
export class LovenseDamageFeedback {
  private readonly states = new WeakMap<object, DamageState>();
  private warned = false;

  constructor(
    private readonly config: LovenseConfig,
    private readonly sender: CommandSender = (command) => this.sendLocalCommand(command),
    private readonly clock: () => number = Date.now,
  ) {}

  attach(proxy: Proxy): void {
    if (!this.config.enabled) return;

    proxy.hookPacket('MAPINFO', (client) => this.reset(client));
    proxy.hookPacket('CREATESUCCESS', (client) => this.reset(client));
    proxy.hookPacket('UPDATE', (client) => this.observeClient(client));
    proxy.hookPacket('NEWTICK', (client) => this.observeClient(client));
    proxy.on('clientDisconnected', (client: ClientConnection) => this.reset(client));
    Logger.log('Lovense', 'Damage feedback enabled (local Game Mode API).');
  }

  reset(source: object): void {
    this.states.delete(source);
  }

  /** Public seam for deterministic tests; runtime uses ClientConnection as source. */
  async observeHealth(source: object, ownerObjectId: number, health: number, maxHealth: number): Promise<void> {
    if (!this.config.enabled || ownerObjectId <= 0 || health < 0 || maxHealth <= 0) return;

    const previous = this.states.get(source);
    if (!previous || previous.ownerObjectId !== ownerObjectId) {
      this.states.set(source, { ownerObjectId, previousHealth: health, lastSentAt: Number.NEGATIVE_INFINITY });
      return;
    }

    const damage = previous.previousHealth - health;
    previous.previousHealth = health;
    if (damage <= 0) return;

    const now = this.clock();
    if (now - previous.lastSentAt < this.config.cooldownMs) return;

    const strength = vibrationStrengthForDamage(damage, maxHealth, this.config);
    if (strength <= 0) return;
    previous.lastSentAt = now;

    const command: LovenseFunctionCommand = {
      command: 'Function',
      action: `Vibrate:${strength}`,
      timeSec: this.config.pulseSeconds,
      apiVer: 1,
      ...(this.config.toyId ? { toy: this.config.toyId } : {}),
    };

    try {
      await this.sender(command);
      this.warned = false;
    } catch {
      if (!this.warned) {
        this.warned = true;
        Logger.warn('Lovense', 'Command failed; check Game Mode endpoint and toy connection.');
      }
    }
  }

  private observeClient(client: ClientConnection): void {
    void this.observeHealth(
      client,
      client.objectId,
      client.playerData.health,
      client.playerData.effectiveMaxHealth,
    );
  }

  private async sendLocalCommand(command: LovenseFunctionCommand): Promise<void> {
    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-platform': 'Realm Engine',
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error('Lovense HTTP request failed');

    const body = await response.json() as { code?: number };
    if (body.code !== undefined && body.code !== 200) throw new Error('Lovense command rejected');
  }
}
