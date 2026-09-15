const manaKey = Symbol.for('realm-engine.ability-mana');
const cooldownKey = Symbol.for('realm-engine.ability-cooldown');
const itemCooldownKey = Symbol.for('realm-engine.ability-item-cooldowns');
type ManaOwner = { mana: number; [manaKey]?: { observed: number; available: number }; [cooldownKey]?: number; [itemCooldownKey]?: Map<number, number> };

export function abilityCooldownMs(xml: string | undefined): number | null {
  if (xml === undefined) return null;
  const values = [...xml.matchAll(/<Cooldown\b[^>]*>\s*([^<]*)\s*<\/Cooldown>/gi)].map(match => match[1].trim());
  if (values.length === 0) return 550;
  const durations = values.map(value => value ? Number(value) * 1000 : NaN);
  if (durations.some(duration => !Number.isFinite(duration) || duration < 0)) return null;
  const duration = Math.ceil(Math.max(...durations)) + 100;
  return Number.isFinite(duration) ? duration : null;
}

export function abilityCooldownReady(player: ManaOwner, itemType?: number): boolean {
  return Date.now() >= Math.max(player[cooldownKey] ?? 0,
    itemType === undefined ? 0 : player[itemCooldownKey]?.get(itemType) ?? 0);
}

export function reserveAbilityCooldown(player: ManaOwner, duration: number, itemType?: number, itemDuration = duration): void {
  if (!Number.isFinite(duration) || duration < 0) return;
  const now = Date.now();
  player[cooldownKey] = Math.max(player[cooldownKey] ?? 0, now + duration);
  if (itemType === undefined || !Number.isInteger(itemType) || itemType <= 0 || !Number.isFinite(itemDuration) || itemDuration < 0) return;
  const deadlines = player[itemCooldownKey] ??= new Map<number, number>();
  for (const [type, deadline] of deadlines) if (deadline <= now) deadlines.delete(type);
  deadlines.set(itemType, Math.max(deadlines.get(itemType) ?? 0, now + itemDuration));
}

export function observeAbilityMana(player: ManaOwner, mana: number): number {
  if (!Number.isFinite(mana) || mana < 0) return 0;
  let state = player[manaKey];
  if (!state) {
    state = { observed: mana, available: mana };
    player[manaKey] = state;
  } else {
    state.available = Math.min(mana, state.available + Math.max(0, mana - state.observed));
    state.observed = mana;
  }
  return state.available;
}

export function reserveAbilityMana(player: ManaOwner, cost: number): void {
  if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(player.mana) || player.mana < 0) return;
  observeAbilityMana(player, player.mana);
  const state = player[manaKey]!;
  state.available = Math.max(0, state.available - cost);
}

export function abilityManaCost(xml: string | undefined): number | null {
  if (xml === undefined) return null;
  const raw = xml.match(/<MpCost\b[^>]*>\s*([^<]*)\s*<\/MpCost>/i)?.[1];
  if (raw === undefined) return 0;
  const cost = Number(raw.trim());
  return raw.trim() && Number.isFinite(cost) && cost >= 0 ? cost : null;
}
