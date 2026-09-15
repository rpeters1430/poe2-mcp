/** Canonicalize GGG API, PoB2, and user-facing equipment slot labels. */
export function normalizeEquipmentSlot(slot: string | null | undefined): string | null {
  if (!slot) return null;
  const lower = slot.trim().toLowerCase();
  // PoB's "Weapon 2" is the active off-hand, while GGG's compact
  // "Weapon2" is the main hand of the swap set. Preserve that distinction.
  if (/^weapon\s+2$/.test(lower)) return "Offhand";
  if (/^weapon\s+1\s+swap$/.test(lower)) return "Weapon2";
  if (/^weapon\s+2\s+swap$/.test(lower)) return "Offhand2";
  const key = lower.replace(/[^a-z0-9]/g, "");
  const fixed: Record<string, string> = {
    helm: "Helm",
    helmet: "Helm",
    bodyarmour: "BodyArmour",
    bodyarmor: "BodyArmour",
    gloves: "Gloves",
    boots: "Boots",
    belt: "Belt",
    amulet: "Amulet",
    ring: "Ring",
    ring1: "Ring",
    ring2: "Ring2",
    weapon: "Weapon",
    weapon1: "Weapon",
    mainhand: "Weapon",
    offhand: "Offhand",
    offhand1: "Offhand",
    weapon2: "Weapon2",
    offhand2: "Offhand2",
    weapon1swap: "Weapon2",
    weaponswap: "Weapon2",
    weapon2swap: "Offhand2",
    offhandswap: "Offhand2",
  };
  if (fixed[key]) return fixed[key];
  if (/^flask\d+$/.test(key)) return `Flask${key.slice(5)}`;
  if (/^charm\d+$/.test(key)) return `Charm${key.slice(5)}`;
  return slot;
}

export function contributesToActiveCharacter(slot: string | null | undefined): boolean {
  const normalized = normalizeEquipmentSlot(slot);
  return normalized !== "Weapon2" && normalized !== "Offhand2" &&
    !normalized?.startsWith("Flask") && !normalized?.startsWith("Charm");
}

export function isActiveWeaponSlot(slot: string | null | undefined): boolean {
  const normalized = normalizeEquipmentSlot(slot);
  return normalized === "Weapon" || normalized === "Offhand";
}
