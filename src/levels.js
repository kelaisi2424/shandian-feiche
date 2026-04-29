// Five-level progression for the racer. Each level reuses the existing
// driving loop but tweaks: track length / curvature, pickup density,
// hazard count, rival count, optional time limit, optional ghost-car
// pacer, and grade thresholds (S/A/B/C).
//
// trackStyle picks one of the three cosmetic backdrops defined in main.js
// (sky / sunset / neon) — fog, sky colour, lighting follow that.

export const LEVELS = [
  {
    id: "lv1",
    num: 1,
    name: "新手教学",
    sub: "STARTER LESSON",
    desc: "直道 + 2 个中弯，吃金币 · 闪过路障 · 跟住对手",
    trackStyle: "sky",
    length: 2400,            // ~50s lap at average 170 km/h
    bend: 0.55,              // gentle natural curves; layout has 2 obvious ones
    heroLayout: true,        // hand-placed pickups/hazards (see spawnHeroPickups)
    // hand-placed scene beats — fractions are along [0..1] of the track:
    nitroAt: [0.46],
    hazardClusters: [
      { at: 0.32, count: 4, lane: -2.0 },
      { at: 0.68, count: 4, lane: 2.0 }
    ],
    checkpointCount: 4,
    checkpointSpread: "even",
    pickupGap: 24,           // dense coin trail
    rampCount: 0,            // no jumps for tutorial — keep it grounded
    hazardCount: 0,          // unused when heroLayout=true; clusters drive it
    rivalCount: 3,
    rivalStyles: ["steady", "aggressive", "mistake"],
    ghost: null,
    timeLimit: 0,
    tutorial: true,
    rainShader: false,
    grades: {
      S: { time: 50, coins: 28, hits: 0 },
      A: { time: 60, coins: 22, hits: 2 },
      B: { time: 70, coins: 14, hits: 5 }
    }
  },
  {
    id: "lv2",
    num: 2,
    name: "限时赛",
    sub: "TIME TRIAL",
    desc: "60 秒内冲过 8 个检查点",
    trackStyle: "sunset",
    length: 2400,
    bend: 0.7,
    checkpointGap: 0,        // forced 8 markers, spacing widens (handled in main.js)
    checkpointCount: 8,
    checkpointSpread: "increasing",
    pickupGap: 30,
    rampCount: 2,
    hazardCount: 0,
    rivalCount: 0,
    ghost: null,
    timeLimit: 60,
    tutorial: false,
    rainShader: false,
    grades: {
      S: { time: 42, coins: 12, hits: 2 },
      A: { time: 52, coins: 8, hits: 4 },
      B: { time: 60, coins: 4, hits: 8 }
    }
  },
  {
    id: "lv3",
    num: 3,
    name: "障碍挑战",
    sub: "OBSTACLE RUN",
    desc: "锥桶 + 路障，撞到会减速，吃金币加分",
    trackStyle: "sky",
    length: 2400,
    bend: 0.8,
    checkpointGap: 380,    // ~6 checkpoints
    pickupGap: 26,
    rampCount: 3,
    hazardCount: 18,
    rivalCount: 0,
    ghost: null,
    timeLimit: 0,
    tutorial: false,
    rainShader: false,
    grades: {
      S: { time: 40, coins: 18, hits: 1 },
      A: { time: 50, coins: 12, hits: 3 },
      B: { time: 65, coins: 8, hits: 6 }
    }
  },
  {
    id: "lv4",
    num: 4,
    name: "氮气挑战",
    sub: "NITRO SPRINT",
    desc: "捡氮气，靠加速通过远距离检查点",
    trackStyle: "sunset",
    length: 2800,
    bend: 1.0,
    checkpointGap: 470,    // ~5 checkpoints, spaced wide
    pickupGap: 36,
    nitroRich: true,       // every other pickup pattern is a nitro
    rampCount: 3,
    hazardCount: 6,
    rivalCount: 1,
    ghost: null,
    timeLimit: 0,
    tutorial: false,
    rainShader: false,
    grades: {
      S: { time: 44, coins: 12, hits: 1 },
      A: { time: 56, coins: 8, hits: 3 },
      B: { time: 75, coins: 5, hits: 6 }
    }
  },
  {
    id: "lv5",
    num: 5,
    name: "夜雨追逐",
    sub: "WET CHASE",
    desc: "湿地反光、镜头震动，倒计时内追上目标车",
    trackStyle: "neon",
    length: 2600,
    bend: 1.2,
    checkpointGap: 520,
    pickupGap: 32,
    rampCount: 3,
    hazardCount: 6,
    rivalCount: 2,
    // ghost = a "target" car with constant speed; player must catch up to it
    ghost: {
      headStart: 110,    // metres ahead of player at GO
      speed: 165,        // km/h — slower than top-tier cars but faster than B-tier
      catchDistance: 6   // counted as caught when player progress >= ghost.progress - this
    },
    timeLimit: 75,
    tutorial: false,
    rainShader: true,
    grades: {
      // beatGhost is checked alongside time/coins/hits — if you don't catch
      // the ghost you can't get S even with perfect lap.
      S: { time: 55, coins: 12, hits: 2, beatGhost: true },
      A: { time: 65, coins: 8, hits: 4, beatGhost: true },
      B: { time: 75, coins: 4, hits: 7, beatGhost: false }
    }
  }
]

export const LEVEL_BY_ID = Object.fromEntries(LEVELS.map((l) => [l.id, l]))

// Compute S / A / B / C from the run summary. `run.finished` must be true
// (race actually completed) — otherwise grade is null and the level is
// considered a failure (no unlock).
export function gradeForRun(level, run) {
  if (!run.finished) return null
  const sec = run.ms / 1000
  for (const tier of ["S", "A", "B"]) {
    const g = level.grades[tier]
    if (!g) continue
    if (
      sec <= g.time &&
      run.coins >= g.coins &&
      run.hits <= g.hits &&
      (g.beatGhost === undefined || g.beatGhost === false || run.beatGhost)
    ) {
      return tier
    }
  }
  return "C"
}

// Default level on a fresh save.
export const DEFAULT_LEVEL_ID = "lv1"

// `lvN+1.id` for the level after id, or null if id is the last one.
export function nextLevelId(id) {
  const i = LEVELS.findIndex((l) => l.id === id)
  return i >= 0 && i < LEVELS.length - 1 ? LEVELS[i + 1].id : null
}

// One-line "tutorial" hint shown over the HUD when level.tutorial is true.
export const TUTORIAL_HINT = "← → 转向 · 双击屏幕放氮气 · 吃金币 + 过门"
