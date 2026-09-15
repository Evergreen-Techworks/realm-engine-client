const manaKey = Symbol.for('realm-engine.ability-mana');
const cooldownKey = Symbol.for('realm-engine.ability-cooldown');
type ManaOwner = { mana: number; [manaKey]?: { observed: number; available: number }; [cooldownKey]?: number };

export function abilityCooldownMs(xml: string | undefined): number | null {
  if (xml === undefined) return null;
  const raw = xml.match(/<Cooldown\b[^>]*>\s*([^<]*)\s*<\/Cooldown>/i)?.[1];
  if (raw === undefined) return 550;
  const duration = Number(raw.trim()) * 1000;
  return raw.trim() && Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function abilityCooldownReady(player: ManaOwner): boolean {
  return Date.now() >= (player[cooldownKey] ?? 0);
}

export function reserveAbilityCooldown(player: ManaOwner, duration: number): void {
  if (!Number.isFinite(duration) || duration < 0) return;
  player[cooldownKey] = Math.max(player[cooldownKey] ?? 0, Date.now() + duration);
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
