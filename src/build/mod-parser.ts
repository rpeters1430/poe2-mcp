import type { ParsedMod } from "../types.js";

/**
 * Best-effort extraction of structured {stat, value} pairs from PoE2 affix
 * text, the same "regex table + always keep the raw text" approach as
 * `adapters/client-log.ts` uses for log lines. Affix wording is community-
 * documented, not GGG-specified, and can drift between patches -- an affix
 * that doesn't match any pattern below still comes through with `matches: []`
 * (never dropped), so callers can see what wasn't understood.
 *
 * Only covers the affixes needed for gear-only defense/offense aggregation
 * (life/mana/ES/armour/evasion/resistances/attributes/speeds/crit/block).
 * Extend the table below if you need another stat.
 */

interface ModPattern {
  regex: RegExp;
  extract: (m: RegExpMatchArray) => Array<{ stat: string; value: number }>;
}

const ELEMENTS = ["Fire", "Cold", "Lightning"] as const;
const ATTRIBUTES = ["Strength", "Dexterity", "Intelligence"] as const;

const PATTERNS: ModPattern[] = [
  {
    regex: /^\+?(-?\d+) to maximum Life$/i,
    extract: (m) => [{ stat: "maximum_life", value: Number(m[1]) }],
  },
  {
    regex: /^\+?(-?\d+) to maximum Mana$/i,
    extract: (m) => [{ stat: "maximum_mana", value: Number(m[1]) }],
  },
  {
    regex: /^\+?(-?\d+) to maximum Energy Shield$/i,
    extract: (m) => [{ stat: "maximum_energy_shield", value: Number(m[1]) }],
  },
  {
    regex: /^(-?\d+)% increased (?:maximum )?Energy Shield$/i,
    extract: (m) => [{ stat: "increased_energy_shield_percent", value: Number(m[1]) }],
  },
  {
    regex: /^(-?\d+)% increased Evasion Rating$/i,
    extract: (m) => [{ stat: "increased_evasion_percent", value: Number(m[1]) }],
  },
  {
    regex: /^(-?\d+)% increased Armour$/i,
    extract: (m) => [{ stat: "increased_armour_percent", value: Number(m[1]) }],
  },
  {
    regex: /^(-?\d+)% increased Armour and Evasion$/i,
    extract: (m) => [
      { stat: "increased_armour_percent", value: Number(m[1]) },
      { stat: "increased_evasion_percent", value: Number(m[1]) },
    ],
  },
  {
    regex: /^(-?\d+)% increased Evasion and Energy Shield$/i,
    extract: (m) => [
      { stat: "increased_evasion_percent", value: Number(m[1]) },
      { stat: "increased_energy_shield_percent", value: Number(m[1]) },
    ],
  },
  {
    regex: /^(-?\d+)% increased Armour and Energy Shield$/i,
    extract: (m) => [
      { stat: "increased_armour_percent", value: Number(m[1]) },
      { stat: "increased_energy_shield_percent", value: Number(m[1]) },
    ],
  },
  {
    regex: /^\+?(-?\d+)% to all Elemental Resistances$/i,
    extract: (m) => ELEMENTS.map((e) => ({ stat: `${e.toLowerCase()}_resistance_percent`, value: Number(m[1]) })),
  },
  {
    regex: /^\+?(-?\d+)% (?:to|increased) (Fire|Cold|Lightning|Chaos) Resistance$/i,
    extract: (m) => [{ stat: `${m[2].toLowerCase()}_resistance_percent`, value: Number(m[1]) }],
  },
  {
    regex: /^\+(-?\d+) to all Attributes$/i,
    extract: (m) => ATTRIBUTES.map((a) => ({ stat: a.toLowerCase(), value: Number(m[1]) })),
  },
  {
    regex: /^\+(-?\d+) to (Strength|Dexterity|Intelligence)$/i,
    extract: (m) => [{ stat: m[2].toLowerCase(), value: Number(m[1]) }],
  },
  {
    regex: /^\+(-?\d+) to Accuracy Rating$/i,
    extract: (m) => [{ stat: "accuracy_rating", value: Number(m[1]) }],
  },
  {
    regex: /^(-?\d+)% increased Attack Speed$/i,
    extract: (m) => [{ stat: "increased_attack_speed_percent", value: Number(m[1]) }],
  },
  {
    regex: /^(-?\d+)% increased Cast Speed$/i,
    extract: (m) => [{ stat: "increased_cast_speed_percent", value: Number(m[1]) }],
  },
  {
    regex: /^(-?\d+)% increased Critical (?:Strike )?Chance$/i,
    extract: (m) => [{ stat: "increased_critical_strike_chance_percent", value: Number(m[1]) }],
  },
  {
    regex: /^\+(-?\d+)% to Critical Damage Bonus$/i,
    extract: (m) => [{ stat: "critical_damage_bonus_percent", value: Number(m[1]) }],
  },
  {
    regex: /^\+(-?\d+)% (?:Chance to Block|to Block chance)$/i,
    extract: (m) => [{ stat: "block_chance_percent", value: Number(m[1]) }],
  },
  {
    regex: /^Adds (\d+) to (\d+) (Physical|Fire|Cold|Lightning|Chaos) Damage(?: to Attacks)?$/i,
    extract: (m) => [
      { stat: `added_${m[3].toLowerCase()}_damage_min`, value: Number(m[1]) },
      { stat: `added_${m[3].toLowerCase()}_damage_max`, value: Number(m[2]) },
    ],
  },
  {
    regex: /^(-?\d+)% increased (Physical|Fire|Cold|Lightning|Chaos|Elemental) Damage$/i,
    extract: (m) => [{ stat: `increased_${m[2].toLowerCase()}_damage_percent`, value: Number(m[1]) }],
  },
  {
    regex: /^\+(-?\d+) to Stun Threshold$/i,
    extract: (m) => [{ stat: "stun_threshold", value: Number(m[1]) }],
  },
  {
    regex: /^(-?\d+(?:\.\d+)?) Life Regeneration per second$/i,
    extract: (m) => [{ stat: "life_regeneration_per_second", value: Number(m[1]) }],
  },
  {
    regex: /^\+(-?\d+) to maximum Life and Mana$/i,
    extract: (m) => [
      { stat: "maximum_life", value: Number(m[1]) },
      { stat: "maximum_mana", value: Number(m[1]) },
    ],
  },
];

export function parseMods(mods: string[]): ParsedMod[] {
  return mods.map((raw) => {
    if (raw.startsWith("{") && raw.endsWith("}")) {
      return { raw, matches: [] };
    }
    const text = raw.replace(/(\d+(?:\.\d+)?)\s*\([0-9.\s-]+\)/g, "$1").trim();
    for (const pattern of PATTERNS) {
      const m = text.match(pattern.regex);
      if (m) return { raw, matches: pattern.extract(m) };
    }
    return { raw, matches: [] };
  });
}

/** Sums every match for a given stat key across a list of already-parsed mods. */
export function sumStat(parsed: ParsedMod[], stat: string): number {
  let total = 0;
  for (const mod of parsed) {
    for (const match of mod.matches) {
      if (match.stat === stat) total += match.value;
    }
  }
  return total;
}
