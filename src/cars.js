// Car catalogue for the racing game. Sourced from the no-logo GLB pack at
// public/models/no_logo_racing_glb_pack/cars_config.json — duplicated here
// as ES module data so the build doesn't have to fetch JSON at runtime.
//
// IDs match the GLB filenames in public/models/ (lightning_s1.glb etc.).
// `body` is a fallback paint colour applied via recolorCar() in case the
// GLB ships untextured — the per-car hue keeps the cars visually distinct
// even with placeholder geometry. Once high-poly real GLBs replace these,
// drop the body/accent fields and let the model's own paint speak.

// Three fictional cars — no real brand names / logos. Tier badges drive
// the colour chip in the garage; price is the coin cost to unlock past
// the starter LIGHTNING S1.
//
// blaze_r / vortex_rs / shadow_zx GLBs still ship in public/models/ so
// they're available for future use, but they're intentionally not in
// this player roster per the 3-car spec.
export const PLAYER_CARS = [
  {
    id: "lightning_s1",
    name: "LIGHTNING S1",
    tier: "C",
    // Kenney Car Kit "race-future" — the higher-detail GLB. Was the
    // ~42KB no-logo variant; that one reads as a low-poly cartoon at
    // hero scale.
    asset: "race-future",
    topSpeed: 248,
    accel0to100: 4.6,
    handling: 8.1,
    nitro: 6.7,
    price: 0,
    body: 0x16a8ff,
    accent: 0x081e4a
  },
  {
    id: "nova_gt",
    name: "NOVA GT",
    tier: "B",
    // Kenney Car Kit "sedan-sports" — sedan/GT silhouette, fits the
    // mid-tier B-class fantasy.
    asset: "sedan-sports",
    topSpeed: 269,
    accel0to100: 3.9,
    handling: 8.4,
    nitro: 7.2,
    price: 2000,
    body: 0x2a78ff,
    accent: 0x081e4a
  },
  {
    id: "phantom_x",
    name: "PHANTOM X",
    tier: "A",
    // Kenney Car Kit "race" — classic supercar silhouette, A-tier hero.
    asset: "race",
    topSpeed: 292,
    accel0to100: 3.4,
    handling: 8.9,
    nitro: 8.0,
    price: 8000,
    body: 0xd0202a,
    accent: 0x340606
  }
]

export const OPPONENT_CARS = [
  {
    id: "rival_one",
    name: "RIVAL ONE",
    tier: "A",
    asset: "rival_one",
    topSpeed: 282,
    aiAggression: 6,
    cornering: 8,
    body: 0xc8d0d8,
    accent: 0x202832
  },
  {
    id: "stormer",
    name: "STORMER",
    tier: "B",
    asset: "stormer",
    topSpeed: 258,
    aiAggression: 5,
    cornering: 7,
    body: 0xffce15,
    accent: 0x3a2a05
  },
  {
    id: "nighthawk",
    name: "NIGHTHAWK",
    tier: "A",
    asset: "nighthawk",
    topSpeed: 295,
    aiAggression: 7,
    cornering: 8,
    body: 0x1a1a28,
    accent: 0x4a5060
  },
  {
    id: "crimson",
    name: "CRIMSON",
    tier: "B",
    asset: "crimson",
    topSpeed: 266,
    aiAggression: 6,
    cornering: 7,
    body: 0xc11a2a,
    accent: 0x320606
  },
  {
    id: "silver_bullet",
    name: "SILVER BULLET",
    tier: "A",
    asset: "silver_bullet",
    topSpeed: 302,
    aiAggression: 5,
    cornering: 8,
    body: 0xe8eef5,
    accent: 0x4a525a
  },
  {
    id: "ghost",
    name: "GHOST",
    tier: "S",
    asset: "ghost",
    topSpeed: 318,
    aiAggression: 8,
    cornering: 9,
    body: 0xfafcff,
    accent: 0x9aa5b2
  },
  {
    id: "ironclad",
    name: "IRONCLAD",
    tier: "B",
    asset: "ironclad",
    topSpeed: 252,
    aiAggression: 8,
    cornering: 6,
    body: 0x4a5260,
    accent: 0x18202a
  },
  {
    id: "velocity",
    name: "VELOCITY",
    tier: "A",
    asset: "velocity",
    topSpeed: 288,
    aiAggression: 4,
    cornering: 9,
    body: 0x1ab8b0,
    accent: 0x062c2a
  },
  {
    id: "onyx",
    name: "ONYX",
    tier: "S",
    asset: "onyx",
    topSpeed: 315,
    aiAggression: 9,
    cornering: 8,
    body: 0x18181c,
    accent: 0xc11a2a
  }
]

// Map id → entry for both pools, used everywhere in the game (rank lookups,
// result modal, garage card etc.) so the rest of the code never has to know
// whether a given car is a player car or an opponent.
export const CAR_BY_ID = Object.fromEntries(
  [...PLAYER_CARS, ...OPPONENT_CARS].map((c) => [c.id, c])
)

// Translate user-facing stats (topSpeed/accel0to100/handling/nitro) into
// the runtime physics knobs the driving loop actually consumes.
export function deriveCarPhysics(car) {
  // nitroSpeed: ~22% boost on top of topSpeed, scaled by the nitro stat,
  // capped so high-tier cars don't blow past the track's collision tolerance.
  const nitroSpeed = Math.min(
    380,
    Math.round(car.topSpeed * 1.18 + (car.nitro ?? 6) * 5)
  )
  return {
    maxSpeed: car.topSpeed,
    nitroSpeed,
    accel: 10 / car.accel0to100,
    steerRate: 5.5 + car.handling * 0.4,
    grip: car.handling
  }
}

// Stable order for the garage grid (matches the user's reference mockup).
export const GARAGE_ORDER = PLAYER_CARS.map((c) => c.id)

// Default for a fresh save / migration of legacy save data.
export const DEFAULT_CAR_ID = "lightning_s1"

// Map old (pre-no-logo) car ids to the closest new car so existing save data
// keeps working after the upgrade.
export const LEGACY_CAR_MAP = {
  sport: "lightning_s1",
  future: "phantom_x",
  sedan: "blaze_r"
}

// Rival AI base speed — derived from the opponent's top speed and cornering
// so high-cornering rivals threaten you on the same track. Capped well below
// the player's max so the rubber-band can pull them up without feeling forced.
export function rivalBaseSpeed(opp) {
  return Math.round(opp.topSpeed * 0.5 + (opp.cornering ?? 7) * 5)
}

// Tier → text colour for the UI badges (matches the mockup's chip palette).
export const TIER_STYLE = {
  C: { bg: "#3a8a52", fg: "#fff" },
  B: { bg: "#2a78ff", fg: "#fff" },
  A: { bg: "#9a3ad4", fg: "#fff" },
  S: { bg: "#ff3a3a", fg: "#fff" }
}
