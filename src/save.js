// Persistent save slot for the racer. Single localStorage key, atomic
// JSON. Do not import this from inside hot loops — read once on init,
// write only on milestone events (race finish / daily / unlock).

const KEY = "shandian-feiche.save.v1"

// Legacy ids from before the no-logo GLB pack landed. load() rewrites
// these to the closest current car so existing players don't get a save
// pointing at a car asset that no longer exists.
const LEGACY_CAR_MAP = {
  sport: "lightning_s1",
  future: "phantom_x",
  sedan: "blaze_r"
}
const VALID_CAR_IDS = new Set([
  "lightning_s1", "nova_gt", "phantom_x", "blaze_r", "vortex_rs", "shadow_zx"
])

const DEFAULT = {
  // economy
  coins: 0,
  gems: 0,
  // progression
  totalRaces: 0,
  bestTimeMs: null,         // best lap on track #0 by car #0
  bestTimePerTrack: {},     // { [trackId]: { ms, carId } }
  unlockedCars: ["lightning_s1"],     // 6 cars total — others unlock with coins
  unlockedTracks: ["neon"],           // sky, sunset, neon — neon default for cinematic look
  selectedCar: "lightning_s1",
  selectedTrack: "neon",
  leaderboard: [],          // [{trackId, carId, ms, coins, hits, at}], top 10 by ms
  // engagement
  lastDaily: null,          // YYYY-MM-DD
  consecutiveDays: 0,
  hasOnboarded: false,
  // settings
  settings: {
    sfxVolume: 0.7,
    musicVolume: 0.5,
    quality: "auto",        // auto, low, medium, high
    controlHint: "swipe",   // swipe, buttons
    privacyAck: false
  }
}

let cache = null

function deepMerge(target, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k])) {
      target[k] = deepMerge({ ...(target[k] || {}) }, src[k])
    } else if (target[k] === undefined) {
      target[k] = src[k]
    }
  }
  return target
}

function migrateLegacyCarIds(s) {
  // remap selectedCar
  if (LEGACY_CAR_MAP[s.selectedCar]) {
    s.selectedCar = LEGACY_CAR_MAP[s.selectedCar]
  } else if (!VALID_CAR_IDS.has(s.selectedCar)) {
    s.selectedCar = "lightning_s1"
  }
  // remap unlockedCars (preserve set semantics — no duplicates)
  if (Array.isArray(s.unlockedCars)) {
    const next = new Set()
    for (const id of s.unlockedCars) {
      const mapped = LEGACY_CAR_MAP[id] ?? id
      if (VALID_CAR_IDS.has(mapped)) next.add(mapped)
    }
    next.add("lightning_s1")   // always own the starter car
    s.unlockedCars = Array.from(next)
  } else {
    s.unlockedCars = ["lightning_s1"]
  }
  return s
}

function load() {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    cache = raw ? deepMerge(JSON.parse(raw), DEFAULT) : { ...DEFAULT, settings: { ...DEFAULT.settings } }
  } catch {
    cache = { ...DEFAULT, settings: { ...DEFAULT.settings } }
  }
  cache = migrateLegacyCarIds(cache)
  return cache
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch (e) {
    console.warn("save failed", e)
  }
}

export const Save = {
  get() { return load() },
  set(patch) { Object.assign(load(), patch); save() },
  setSettings(patch) { Object.assign(load().settings, patch); save() },
  addCoins(n) {
    const s = load()
    s.coins = Math.max(0, s.coins + n)
    save()
    return s.coins
  },
  addGems(n) {
    const s = load()
    s.gems = Math.max(0, s.gems + n)
    save()
    return s.gems
  },
  unlockCar(id) {
    const s = load()
    if (!s.unlockedCars.includes(id)) s.unlockedCars.push(id)
    save()
  },
  unlockTrack(id) {
    const s = load()
    if (!s.unlockedTracks.includes(id)) s.unlockedTracks.push(id)
    save()
  },
  recordRace({ trackId, carId, ms, coins, hits, success }) {
    const s = load()
    s.totalRaces++
    if (success) {
      const prev = s.bestTimePerTrack[trackId]
      if (!prev || ms < prev.ms) s.bestTimePerTrack[trackId] = { ms, carId }
      if (!s.bestTimeMs || ms < s.bestTimeMs) s.bestTimeMs = ms
      s.leaderboard.push({ trackId, carId, ms, coins, hits, at: Date.now() })
      s.leaderboard.sort((a, b) => a.ms - b.ms)
      s.leaderboard = s.leaderboard.slice(0, 10)
    }
    s.coins += coins
    save()
  },
  // returns { granted: bool, amount: number, day: number }
  claimDaily() {
    const s = load()
    const today = new Date().toISOString().slice(0, 10)
    if (s.lastDaily === today) return { granted: false, amount: 0, day: s.consecutiveDays }
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    if (s.lastDaily === yesterday) s.consecutiveDays += 1
    else s.consecutiveDays = 1
    const amounts = [50, 80, 120, 180, 280, 400, 600]
    const idx = Math.min(s.consecutiveDays - 1, amounts.length - 1)
    const amount = amounts[idx]
    s.coins += amount
    s.lastDaily = today
    save()
    return { granted: true, amount, day: s.consecutiveDays }
  },
  isCarUnlocked(id) { return load().unlockedCars.includes(id) },
  isTrackUnlocked(id) { return load().unlockedTracks.includes(id) }
}
