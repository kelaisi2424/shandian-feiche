/*
⚠️ 关键约束（V1.8 起，不许违反）

玩家车 scale 通过 cars.js 的 modelScale 控制，严格限制 [0.8, 1.3]

相机必须真正跟车，distanceTo(player) 报警 <20，目标 8-12

body/wheel mesh 不允许 emissive、transparent、opacity<1

不允许 BoxGeometry 给玩家车做"光晕外壳"

障碍物必须用 GLB（Kenney CC0），加载失败 fallback 必须报警

mesh 数用基线突变检测（baseline + 6），不是硬上限

验证工具：src/utils/audit.js -> runAudit()
手动验证：浏览器 console 输入 window.__audit()
*/
import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js"
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js"
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js"
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import { Save } from "./save.js"
import {
  PLAYER_CARS,
  OPPONENT_CARS,
  CAR_BY_ID,
  DEFAULT_CAR_ID,
  deriveCarPhysics,
  applyModelScale,
  rivalBaseSpeed,
  rivalClassesForLevel,
  TIER_STYLE
} from "./cars.js"
import {
  LEVELS,
  LEVEL_BY_ID,
  DEFAULT_LEVEL_ID,
  gradeForRun,
  nextLevelId,
  TUTORIAL_HINT
} from "./levels.js"
import { captureBaseline, runAudit } from "./utils/audit.js"
// V1.8.3a-2: side-effect import that mounts window.__tune.speedCapMultiplier.
// No values consumed at import time; updateDriving reads window.__tune
// per-frame so console adjustments take effect on the next loop tick.
import "./utils/tune.js"
import "./styles.css"

// ────────────────────────────────────────────────────────────────────
// orientation guard — runs FIRST, before any other init.
// Two product states only:
//   body.is-landscape → playable game shell renders
//   body.is-portrait  → only the rotate-gate renders
// Wired to resize + orientationchange + matchMedia so any of the three
// signals can trigger a state flip the moment the device rotates.
// ────────────────────────────────────────────────────────────────────
function applyOrientationClass() {
  // viewport-size check is the source of truth — matchMedia lies on some
  // mobile browsers when the address bar collapses. Both must agree on
  // "portrait" before we lock to portrait.
  const portraitByMM = window.matchMedia
    ? window.matchMedia("(orientation: portrait)").matches
    : false
  const portraitBySize = window.innerHeight > window.innerWidth
  const portrait = portraitByMM && portraitBySize
  const apply = () => {
    const b = document.body
    if (!b) return
    b.classList.toggle("is-portrait", portrait)
    b.classList.toggle("is-landscape", !portrait)
  }
  if (document.body) apply()
  else document.addEventListener("DOMContentLoaded", apply, { once: true })
}
applyOrientationClass()
window.addEventListener("resize", applyOrientationClass)
window.addEventListener("orientationchange", applyOrientationClass)
if (window.matchMedia) {
  const mm = window.matchMedia("(orientation: portrait)")
  // newer addEventListener form first, fall back to deprecated addListener
  if (mm.addEventListener) mm.addEventListener("change", applyOrientationClass)
  else if (mm.addListener) mm.addListener(applyOrientationClass)
}

// ────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t
const rand = (a, b) => a + Math.random() * (b - a)
const tau = Math.PI * 2

const CFG = {
  segLength: 8,
  roadHalfWidth: 7.4,
  laneHalfWidth: 5.4,
  playerHalfWidth: 4.6,
  rivalCount: 5,
  pickupGap: 26,
  rampGap: 180,
  checkpointGap: 260,
  hitLimit: 10,
  coinGoal: 18,
  // overridden when track loads
  trackLength: 2300,
  finishZ: -2250,
  maxSpeed: 215,
  nitroSpeed: 305,
  nitroDuration: 2.4
}

// All cars (player + rivals) come from src/cars.js — sourced from the
// no-logo GLB pack. Lookup helpers are imported above; the rest of the
// game refers to a car by `CAR_BY_ID[id]`.

// 3 selectable tracks
const TRACKS = {
  sky: {
    id: "sky",
    label: "蓝天跳台",
    desc: "经典空中赛道",
    cost: 0,
    length: 2200,
    sky: 0x9bd0f6,
    fog: [0x9bd0f6, 220, 760],
    sun: 0xfff5d8,
    edgeMode: "chevron",
    rampGap: 180
  },
  sunset: {
    id: "sunset",
    label: "落日大道",
    desc: "金色黄昏",
    cost: 600,
    length: 2600,
    sky: 0xff9b56,
    fog: [0xff9b56, 200, 700],
    sun: 0xffe1aa,
    edgeMode: "chevron",
    rampGap: 150
  },
  neon: {
    id: "neon",
    label: "霓虹夜幕",
    desc: "夜间城市赛道",
    cost: 0,                          // unlocked by default for the cinematic experience
    length: 2400,
    sky: 0x050a1a,
    fog: [0x050a1a, 110, 460],        // tighter night fog for atmosphere
    sun: 0x6688cc,                    // moonlight tone
    edgeMode: "chevron",
    rampGap: 200
  }
}

const state = {
  mode: "boot",
  speed: 0,
  // track-space coordinates (replace world x/z):
  progress: 0,         // distance traveled along the spline (m, 0 → Track.length)
  lateral: 0,          // offset from centerline (m, ±playerHalfWidth)
  y: 0.22,             // height above the road surface (m)
  vy: 0,
  steer: 0,
  steerVisual: 0,
  gas: 0,
  brake: 0,
  nitroCharges: 1,
  nitroTime: 0,
  coins: 0,
  hits: 0,
  shake: 0,
  startedAt: 0,
  pauseAt: 0,
  pauseAcc: 0,
  finished: false,
  finishedAt: 0,
  toastUntil: 0,
  toastText: "",
  lastRivalHit: 0,
  airborne: false,
  airSince: 0,
  countdown: 0,
  // Slow-mo factor applied to the loop's dt. Ramps push it to 0.4 for a
  // brief cinematic jump, then it eases back to 1. Persisted on state so
  // updateRamps() doesn't need to thread a closure through.
  timeScale: 1,
  // Timestamp (perf.now) until which the player's body materials should
  // flash bright white — set when a collision lands. updatePlayerFlash()
  // reads it every frame and restores cached emissive when the window ends.
  flashUntil: 0,
  // Timestamp until which a saturation boost is applied for nitro pop.
  nitroSaturateUntil: 0,
  // level system
  level: null,           // current LEVEL_BY_ID entry while a race is running
  ghost: null,           // { car, progress, speed, beaten } when level.ghost is set
  beatGhost: false,
  timedOut: false        // true if level.timeLimit hit before finish
}

// the curved track itself (CatmullRom spline + length cache + helpers)
const Track = {
  curve: null,
  length: 0,
  _up: new THREE.Vector3(0, 1, 0),
  _tan: new THREE.Vector3(),
  _pos: new THREE.Vector3(),
  _right: new THREE.Vector3()
}

let renderer, scene, camera, composer, bloomPass
const track = new THREE.Group()
const world = new THREE.Group()
const dynamic = new THREE.Group()
const particles = new THREE.Group()
let player, playerBody, nitroPlume, headlight, skyDome
let rainGroup = null            // per-level rain effect, only used by lv5
let rivals = []
let pickups = []
let ramps = []
let checkpoints = []
let assets = {}
let last = performance.now()
const mats = {}

// ────────────────────────────────────────────────────────────────────
// audio (Web Audio synthesised engine loop + SFX, no asset downloads)
// ────────────────────────────────────────────────────────────────────
const audio = {
  ctx: null,
  master: null,
  engine: null,    // { osc1, osc2, gain }
  windGain: null,
  unlocked: false
}

function unlockAudio() {
  if (audio.unlocked) return
  audio.unlocked = true
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return
  audio.ctx = new Ctx()
  audio.master = audio.ctx.createGain()
  audio.master.gain.value = (Save?.get?.()?.settings?.sfxVolume) ?? 0.6
  audio.master.connect(audio.ctx.destination)
  audio.musicGain = audio.ctx.createGain()
  audio.musicGain.gain.value = (Save?.get?.()?.settings?.musicVolume) ?? 0.4
  audio.musicGain.connect(audio.ctx.destination)
  initMusic()

  // Engine drone: saw + square + sub oscillator through a speed-modulated
  // lowpass. A slow LFO on osc1 frequency adds the "lumpy" rumble that
  // sells the engine as a real machine instead of a static buzz.
  const osc1 = audio.ctx.createOscillator()
  const osc2 = audio.ctx.createOscillator()
  const oscSub = audio.ctx.createOscillator()
  osc1.type = "sawtooth"
  osc2.type = "square"
  oscSub.type = "sine"
  osc1.frequency.value = 60
  osc2.frequency.value = 90
  oscSub.frequency.value = 30
  // LFO → tiny pitch warble (~6 Hz, ±4 Hz on osc1) for combustion lumpiness
  const lfo = audio.ctx.createOscillator()
  const lfoGain = audio.ctx.createGain()
  lfo.frequency.value = 6
  lfoGain.gain.value = 4
  lfo.connect(lfoGain)
  lfoGain.connect(osc1.frequency)
  lfo.start()
  const lp = audio.ctx.createBiquadFilter()
  lp.type = "lowpass"
  lp.frequency.value = 900
  const eg = audio.ctx.createGain()
  eg.gain.value = 0
  // Sub feeds into engine gain through its own (smaller) gain so it adds
  // chest-thump without muddying the high end.
  const subGain = audio.ctx.createGain()
  subGain.gain.value = 0.5
  osc1.connect(lp)
  osc2.connect(lp)
  lp.connect(eg)
  oscSub.connect(subGain)
  subGain.connect(eg)
  eg.connect(audio.master)
  osc1.start()
  osc2.start()
  oscSub.start()
  audio.engine = { osc1, osc2, oscSub, gain: eg, lp }

  // wind: white noise → bandpass
  const buf = audio.ctx.createBuffer(1, audio.ctx.sampleRate * 2, audio.ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const noise = audio.ctx.createBufferSource()
  noise.buffer = buf
  noise.loop = true
  const bp = audio.ctx.createBiquadFilter()
  bp.type = "bandpass"
  bp.frequency.value = 600
  bp.Q.value = 0.6
  const wg = audio.ctx.createGain()
  wg.gain.value = 0
  noise.connect(bp)
  bp.connect(wg)
  wg.connect(audio.master)
  noise.start()
  audio.windGain = wg
}

function setEngineLoad(speedKmh, nitroOn) {
  if (!audio.engine) return
  // map 0..305 km/h to 50..420 Hz on osc1; osc2 = osc1*1.5; subOsc = osc1*0.5
  const f = 50 + (speedKmh / 305) * 360
  const t = audio.ctx.currentTime
  audio.engine.osc1.frequency.setTargetAtTime(f, t, 0.05)
  audio.engine.osc2.frequency.setTargetAtTime(f * 1.5, t, 0.05)
  audio.engine.oscSub.frequency.setTargetAtTime(f * 0.5, t, 0.05)
  audio.engine.lp.frequency.setTargetAtTime(700 + (speedKmh / 305) * 1500, t, 0.08)
  // More dynamic range so you actually feel the throttle: idle 0.16, mid
  // 0.32, top 0.42, nitro slams to 0.55. Was 0.22/0.35 — flat across the
  // run, so the engine never seemed to react to gas.
  const speedRatio = speedKmh / 305
  const baseGain = 0.16 + speedRatio * 0.26   // 0.16 → 0.42
  const target = state.mode === "playing" ? (nitroOn ? 0.55 : baseGain) : 0
  audio.engine.gain.gain.setTargetAtTime(target, t, 0.1)
  audio.windGain.gain.setTargetAtTime(state.mode === "playing" ? Math.min(0.22, speedRatio * 0.22) : 0, t, 0.15)
}

function sfxImpact() {
  if (!audio.ctx) return
  const now = audio.ctx.currentTime

  // Layer 1 — metallic noise burst through bandpass (the "crunch")
  const buf = audio.ctx.createBuffer(1, audio.ctx.sampleRate * 0.3, audio.ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.4)
  const src = audio.ctx.createBufferSource()
  src.buffer = buf
  const bp = audio.ctx.createBiquadFilter()
  bp.type = "bandpass"
  bp.frequency.value = 1500
  bp.Q.value = 1.5
  const g = audio.ctx.createGain()
  g.gain.setValueAtTime(0.6, now)
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.28)
  src.connect(bp); bp.connect(g); g.connect(audio.master)
  src.start(now)
  src.stop(now + 0.3)

  // Layer 2 — sub-bass thud (a fast 110→40Hz sine drop). This is what
  // turns a brittle "tssh" into a chest-thump "BANG".
  const thud = audio.ctx.createOscillator()
  thud.type = "sine"
  thud.frequency.setValueAtTime(110, now)
  thud.frequency.exponentialRampToValueAtTime(40, now + 0.15)
  const tg = audio.ctx.createGain()
  tg.gain.setValueAtTime(0, now)
  tg.gain.linearRampToValueAtTime(0.7, now + 0.005)
  tg.gain.exponentialRampToValueAtTime(0.001, now + 0.28)
  thud.connect(tg); tg.connect(audio.master)
  thud.start(now); thud.stop(now + 0.32)

  // Layer 3 — short distorted square crack at the very front for transient
  // attack. ~12ms long, drops fast, gives the impact its leading edge.
  const crack = audio.ctx.createOscillator()
  crack.type = "square"
  crack.frequency.setValueAtTime(180, now)
  const cg = audio.ctx.createGain()
  cg.gain.setValueAtTime(0.4, now)
  cg.gain.exponentialRampToValueAtTime(0.001, now + 0.04)
  crack.connect(cg); cg.connect(audio.master)
  crack.start(now); crack.stop(now + 0.05)

  // public hook for future external SFX (e.g. swap in a real crash sample
  // by reassigning window.sfxHit = () => myAudio.play()). No-op by default.
  if (typeof window !== "undefined" && typeof window.sfxHit === "function") {
    try { window.sfxHit() } catch (_) {}
  }
}

function sfxNitro() {
  if (!audio.ctx) return
  const now = audio.ctx.currentTime
  const osc = audio.ctx.createOscillator()
  osc.type = "sawtooth"
  osc.frequency.setValueAtTime(220, now)
  osc.frequency.exponentialRampToValueAtTime(900, now + 0.45)
  const g = audio.ctx.createGain()
  g.gain.setValueAtTime(0.0, now)
  g.gain.linearRampToValueAtTime(0.32, now + 0.05)
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.5)
  osc.connect(g); g.connect(audio.master)
  osc.start(now); osc.stop(now + 0.55)
}

// Procedural BGM: 8-step arpeggio + sub bass. Two tempos: chill (menu) and
// race (faster + filtered up). Generated via repeating setTimeout-style
// scheduler on the AudioContext clock.
let musicTimer = null
let musicMode = "menu"
function initMusic() {
  setMusicMode("menu")
}
function setMusicMode(mode) {
  if (!audio.ctx) return
  if (mode === musicMode) return
  musicMode = mode
  if (musicTimer) {
    clearTimeout(musicTimer)
    musicTimer = null
  }
  scheduleMusic()
}
function scheduleMusic() {
  if (!audio.ctx) return
  const ctx = audio.ctx
  const now = ctx.currentTime
  // chill: A minor pentatonic, race: same notes faster + brighter
  const notes = [220, 261.63, 329.63, 392, 440, 392, 329.63, 261.63]
  const tempo = musicMode === "race" ? 0.18 : 0.32  // seconds per note
  const filterFreq = musicMode === "race" ? 2400 : 1100
  const noteCount = notes.length
  for (let i = 0; i < noteCount; i++) {
    const t = now + i * tempo
    const f = notes[i]
    const osc = ctx.createOscillator()
    osc.type = "triangle"
    osc.frequency.value = f
    const filt = ctx.createBiquadFilter()
    filt.type = "lowpass"
    filt.frequency.value = filterFreq
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.18, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.001, t + tempo * 0.95)
    osc.connect(filt); filt.connect(g); g.connect(audio.musicGain)
    osc.start(t); osc.stop(t + tempo)

    // bass on every 2nd note
    if (i % 2 === 0) {
      const b = ctx.createOscillator()
      b.type = "sine"
      b.frequency.value = f / 2
      const bg = ctx.createGain()
      bg.gain.setValueAtTime(0.0, t)
      bg.gain.linearRampToValueAtTime(0.12, t + 0.02)
      bg.gain.exponentialRampToValueAtTime(0.001, t + tempo * 1.6)
      b.connect(bg); bg.connect(audio.musicGain)
      b.start(t); b.stop(t + tempo * 1.7)
    }
  }
  // schedule next loop
  musicTimer = setTimeout(scheduleMusic, noteCount * tempo * 1000)
}

// Checkpoint / finish chord — three rising triangle pings staggered 80ms
// apart (C5 → E5 → G5, ascending major triad). Reads as a victory cue
// without stomping on the underlying engine drone.
function sfxCheckpoint() {
  if (!audio.ctx) return
  const now = audio.ctx.currentTime
  const ping = (delay, freq, dur) => {
    const startAt = now + delay
    const osc = audio.ctx.createOscillator()
    osc.type = "triangle"
    osc.frequency.setValueAtTime(freq, startAt)
    const g = audio.ctx.createGain()
    g.gain.setValueAtTime(0, startAt)
    g.gain.linearRampToValueAtTime(0.18, startAt + 0.005)
    g.gain.exponentialRampToValueAtTime(0.001, startAt + dur)
    osc.connect(g); g.connect(audio.master)
    osc.start(startAt); osc.stop(startAt + dur + 0.05)
  }
  ping(0,    523.25, 0.20)   // C5
  ping(0.08, 659.25, 0.22)   // E5
  ping(0.16, 783.99, 0.30)   // G5 — slightly longer tail
}

function sfxCoin() {
  if (!audio.ctx) return
  const now = audio.ctx.currentTime
  // Classic "ding-ding" chime: two stacked triangle pings, the second a
  // perfect fifth above and 60ms later. Each ping is brief and bright.
  const ping = (startAt, freq, peakGain, dur) => {
    const osc = audio.ctx.createOscillator()
    osc.type = "triangle"
    osc.frequency.setValueAtTime(freq, startAt)
    osc.frequency.linearRampToValueAtTime(freq * 1.05, startAt + 0.05)
    // Add a tiny sine sub for body so the ding doesn't sound thin
    const sub = audio.ctx.createOscillator()
    sub.type = "sine"
    sub.frequency.setValueAtTime(freq * 0.5, startAt)
    const g = audio.ctx.createGain()
    g.gain.setValueAtTime(0, startAt)
    g.gain.linearRampToValueAtTime(peakGain, startAt + 0.005)
    g.gain.exponentialRampToValueAtTime(0.001, startAt + dur)
    osc.connect(g); sub.connect(g); g.connect(audio.master)
    osc.start(startAt); sub.start(startAt)
    osc.stop(startAt + dur + 0.05); sub.stop(startAt + dur + 0.05)
  }
  ping(now,         988,  0.22, 0.18)   // B5 — first ding
  ping(now + 0.06,  1480, 0.20, 0.22)   // F#6 — second ding (perfect fifth up)
}
const tmpVec = new THREE.Vector3()
const cameraTarget = new THREE.Vector3()
const cameraLook = new THREE.Vector3()
const _camTargetPos = new THREE.Vector3()
const _camLookAt = new THREE.Vector3()
const _forward = new THREE.Vector3()
// V1.8.7: motion-derived chase camera state. lastPlayerPos and
// lastValidMoveDir track the player's actual world-space displacement
// over time so the camera follows movement, not player.quaternion's
// "forward" axis (which we measured to be in the OPPOSITE direction
// of motion in playing mode → camera ended up ahead of the car).
const _camLastPlayerPos = new THREE.Vector3()
const _camLastValidMoveDir = new THREE.Vector3()
let _camLastPlayerPosInit = false
let auditFrame = 0
let auditOverlay = null

function inspectLegacyScaleStorage() {
  const inspected = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (/shandian-feiche|scale/i.test(key)) inspected.push(key)
      if (/scale/i.test(key)) {
        const raw = localStorage.getItem(key)
        const num = Number(raw)
        if (Number.isFinite(num) && num > 1.5) {
          console.warn(`[scale-guard] Reset legacy localStorage key "${key}" from ${raw} to 1.0`)
          localStorage.setItem(key, "1.0")
        }
      }
    }
  } catch (e) {
    console.warn("[scale-guard] localStorage scale inspection failed", e)
  }
  console.log("[scale-guard] inspected localStorage keys:", inspected)
  window.__scaleStorageKeys = inspected
}

// ────────────────────────────────────────────────────────────────────
// init
// ────────────────────────────────────────────────────────────────────
async function init() {
  // CRITICAL: bind the rotate-gate button FIRST, before any async work.
  // loadAssets() below pulls 20+ GLB files which can take tens of seconds
  // on slow mobile networks — if we wait until after that to wire the
  // button, the user's click during loading is a silent no-op.
  bindRotateGate()
  inspectLegacyScaleStorage()
  setStageScale()

  renderer = new THREE.WebGLRenderer({
    canvas: $("game"),
    antialias: true,
    powerPreference: "high-performance"
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.95
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x1a1430)
  scene.fog = new THREE.Fog(0x2a2638, 350, 1200)

  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1500)
  camera.position.set(0, 6, 30)
  scene.add(track, world, dynamic, particles)

  scene.add(new THREE.HemisphereLight(0x88aaff, 0x442266, 0.6))
  const sun = new THREE.DirectionalLight(0xfff5d8, 1.5)
  sun.position.set(110, 140, 60)
  sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024)
  sun.shadow.camera.left = -120
  sun.shadow.camera.right = 120
  sun.shadow.camera.top = 120
  sun.shadow.camera.bottom = -80
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = 420
  sun.shadow.bias = -0.0005
  scene.add(sun)
  const fill = new THREE.DirectionalLight(0x9ed8ff, 0.4)
  fill.position.set(-60, 30, -120)
  scene.add(fill)

  // Studio env map for clean car paint reflections.
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  pmrem.dispose()

  // post-processing — bloom on glow elements (lights, nitro, coins, neon)
  composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(innerWidth, innerHeight),
    0.25,    // strength — subtle
    0.4,     // radius
    0.92     // threshold — only very bright pixels (lights, nitro, coins)
  )
  composer.addPass(bloomPass)
  composer.addPass(new OutputPass())

  buildMaterials()
  await loadAssets()
  buildSky()
  buildTrack()
  buildScenery()
  buildPlayer()
  spawnRivals()
  spawnPickups()
  spawnRamps()
  spawnCheckpoints()
  bindControls()
  bindMetaControls()
  bindAudioUnlock()
  refreshCurrencyHud()
  applyQuality()
  resize()
  const refit = () => { setStageScale(); resize() }
  addEventListener("resize", refit)
  addEventListener("orientationchange", () => { refit(); setTimeout(refit, 250) })
  if (window.matchMedia) {
    const mm = window.matchMedia("(orientation: portrait)")
    if (mm.addEventListener) mm.addEventListener("change", refit)
    else if (mm.addListener) mm.addListener(refit)
  }
  // Mobile browsers can report a stale viewport during page-load (address
  // bar collapsing, WeChat's settled-after-launch dimensions, async asset
  // loading). Re-run scale + WebGL viewport sync on staggered timers so the
  // visible layout always catches up to the actual viewport.
  setTimeout(refit, 80)
  setTimeout(refit, 320)
  setTimeout(refit, 1000)
  // expose for debugging
  window.__state = state
  window.__Track = Track
  window.__player = player
  window.__camera = camera
  window.__renderer = renderer
  window.__composer = composer
  window.__scene = scene
  if (import.meta.env.DEV) {
    window.__audit = () => {
      const issues = runAudit(window.__player, window.__scene, window.__camera)
      console.log("[audit]", issues.length === 0 ? "✅ all clean" : issues)
      return issues
    }
  }

  // assets ready → menu is the initial state. No splash, no two-stage
  // launch flow. The menu HTML markup ships with `class="… active"` so
  // it's already on screen by the time we get here.
  setMode("menu")
  if (new URLSearchParams(location.search).get("demo") === "1") {
    runDemoSequence()
  } else {
    maybeShowDailyBonus()
  }

  requestAnimationFrame(loop)
}

// Autopilot for the lv1 vertical slice (URL flag ?demo=1). Drives the
// menu → garage → race → nitro → result flow on timers so a 30-40s screen
// recording captures the full pitch. No UI changes — just sequenced clicks
// and a couple of programmatic fireNitro() calls during the race.
function runDemoSequence() {
  const at = (ms, fn) => setTimeout(() => { try { fn() } catch (_) {} }, ms)
  // Quietly dismiss any blocking modals (privacy / daily) if present
  at(200, () => $("privacyAckBtn") && document.querySelector("#privacyScreen.active") && $("privacyAckBtn").click())
  at(500, () => $("dailyClaimBtn") && document.querySelector("#dailyScreen.active") && $("dailyClaimBtn").click())
  // 1) brief menu shot, then open the garage
  at(2500, () => $("garageTile").click())
  // 2) try to switch to NOVA GT (the second card). If locked, force-unlock
  //    via Save so the demo can still showcase a car switch.
  at(4200, () => {
    Save.unlockCar("nova_gt")
    Save.set({ selectedCar: "nova_gt" })
    rebuildPlayerCar()
    // re-render the garage so the highlight moves
    if (typeof openGarage === "function") openGarage()
  })
  // 3) close garage
  at(6000, () => $("garageCloseBtn").click())
  // 4) start race
  at(7200, () => $("startGame").click())
  // 5) during race: fire nitro at the right moments and steer to dodge the
  //    two cone clusters (lv1 places them at 32% and 68% of track length,
  //    on lanes -2 and +2 respectively). This produces a clean run that
  //    shows nitro FX, overtakes, and reaches the finish for the result.
  let nitro1 = false
  let nitro2 = false
  const pulse = setInterval(() => {
    if (state.mode === "result") { clearInterval(pulse); state.steer = 0; return }
    if (state.mode !== "playing") return
    if (state.countdown > 0) return
    const t = (performance.now() - state.startedAt - state.pauseAcc) / 1000
    if (!nitro1 && t >= 5 && state.nitroCharges > 0) { fireNitro(); nitro1 = true }
    if (!nitro2 && t >= 20 && state.nitroCharges > 0) { fireNitro(); nitro2 = true }
    // dodge the cone clusters by steering opposite to their lane.
    // cluster1 at 32% (lane -2) → steer right; cluster2 at 68% (lane +2) → steer left.
    const len = Track.length || 2400
    const p = state.progress
    const c1 = len * 0.32
    const c2 = len * 0.68
    if (Math.abs(p - c1) < 50) state.steer = 0.55
    else if (Math.abs(p - c2) < 50) state.steer = -0.55
    else state.steer = 0
  }, 80)
  // failsafe — stop the poller after 90s no matter what
  setTimeout(() => clearInterval(pulse), 90000)
}

// ────────────────────────────────────────────────────────────────────
// materials & textures
// ────────────────────────────────────────────────────────────────────
function buildMaterials() {
  // Solid dark asphalt — no map. The previous map-based road was leaving
  // material.color = #ffffff (default) which read as pure white in
  // diagnostics; the texture's #2a2a3e base wasn't reliably showing.
  // Now the colour comes straight off the material so the road renders
  // dark consistently regardless of texture loader state.
  mats.roadCenter = new THREE.MeshStandardMaterial({
    color: 0x2a2a3e,
    roughness: 0.85,
    metalness: 0.05,
    envMapIntensity: 0.15
  })
  mats.roadEdge = new THREE.MeshStandardMaterial({
    color: 0x1f2138,
    roughness: 0.85,
    metalness: 0.05,
    envMapIntensity: 0.2
  })
  mats.roadEdgeR = new THREE.MeshStandardMaterial({
    color: 0x1f2138,
    roughness: 0.85,
    metalness: 0.05,
    envMapIntensity: 0.2
  })
  // Rails get a low-intensity emissive so they read as glowing strips at
  // night / dusk lighting without dominating the scene during the day.
  mats.rail = new THREE.MeshStandardMaterial({
    color: 0x0e63b8,
    emissive: 0x1a4cff,
    emissiveIntensity: 0.18,
    roughness: 0.32,
    metalness: 0.45
  })
  mats.railTop = new THREE.MeshStandardMaterial({
    color: 0xffd11a,
    emissive: 0xff8a16,
    emissiveIntensity: 0.22,
    roughness: 0.4,
    metalness: 0.18
  })
  mats.support = new THREE.MeshStandardMaterial({ color: 0x1a263a, roughness: 0.55 })
  mats.ramp = new THREE.MeshStandardMaterial({
    color: 0xffce15,
    roughness: 0.36,
    metalness: 0.18
  })
  mats.dark = new THREE.MeshStandardMaterial({ color: 0x101a2c, roughness: 0.55 })
  mats.gold = new THREE.MeshStandardMaterial({
    color: 0xffd23a,
    emissive: 0xff9b0c,
    emissiveIntensity: 0.6,
    roughness: 0.28,
    metalness: 0.42
  })
  mats.cyan = new THREE.MeshStandardMaterial({
    color: 0x2ec8ff,
    emissive: 0x1e8eff,
    emissiveIntensity: 0.7
  })
  mats.checker = new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.45 })
  mats.banner = new THREE.MeshBasicMaterial({ map: bannerTexture(), transparent: true })
}

function roadCenterTexture() {
  const c = document.createElement("canvas")
  c.width = c.height = 512
  const g = c.getContext("2d")
  // Dark asphalt base — was bright yellow which made the road read as
  // a frozen surface. Slightly lighter than the previous #1a1a2e so the
  // road catches the dusk lighting and the player car silhouette stays
  // readable at night-track fog levels.
  g.fillStyle = "#2a2a3e"
  g.fillRect(0, 0, 512, 512)
  // subtle aggregate speckle so the asphalt isn't flat
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(${100 + Math.random() * 70}, ${100 + Math.random() * 70}, ${120 + Math.random() * 60}, ${0.05 + Math.random() * 0.12})`
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2)
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function roadEdgeTexture(flip = false) {
  const c = document.createElement("canvas")
  c.width = c.height = 256
  const g = c.getContext("2d")
  g.fillStyle = "#0c5fb6"
  g.fillRect(0, 0, 256, 256)
  // big alternating blue squares — like the wide checker pattern in the
  // reference screenshot. Two shades of blue + faint yellow inner stripe.
  const cell = 64
  for (let y = 0; y < 256; y += cell) {
    for (let x = 0; x < 256; x += cell) {
      const isLight = ((x / cell) + (y / cell)) % 2 === 0
      g.fillStyle = isLight ? "#1392ff" : "#0c5fb6"
      g.fillRect(x, y, cell, cell)
      // inset darker border for depth
      g.strokeStyle = isLight ? "#0a55a8" : "#062c66"
      g.lineWidth = 2
      g.strokeRect(x + 1, y + 1, cell - 2, cell - 2)
    }
  }
  // yellow inner-edge stripe
  g.fillStyle = "#ffd31a"
  g.fillRect(flip ? 240 : 0, 0, 16, 256)
  // narrow white safety stripe just inside the yellow
  g.fillStyle = "rgba(255, 255, 255, 0.7)"
  g.fillRect(flip ? 232 : 16, 0, 4, 256)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function checkerTexture() {
  const c = document.createElement("canvas")
  c.width = c.height = 64
  const g = c.getContext("2d")
  g.fillStyle = "#fff"
  g.fillRect(0, 0, 64, 64)
  g.fillStyle = "#111"
  for (let y = 0; y < 64; y += 16)
    for (let x = (y / 16) % 2 === 0 ? 0 : 16; x < 64; x += 32)
      g.fillRect(x, y, 16, 16)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(2, 1)
  t.magFilter = THREE.NearestFilter
  return t
}

function bannerTexture() {
  const c = document.createElement("canvas")
  c.width = 512
  c.height = 128
  const g = c.getContext("2d")
  const grd = g.createLinearGradient(0, 0, 512, 0)
  grd.addColorStop(0, "#ff7d2a")
  grd.addColorStop(1, "#ffce40")
  g.fillStyle = grd
  g.fillRect(0, 0, 512, 128)
  g.fillStyle = "#fff"
  g.font = "bold 80px Arial"
  g.fillText("LIGHTNING", 30, 90)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// ────────────────────────────────────────────────────────────────────
// asset loading
// ────────────────────────────────────────────────────────────────────
async function loadAssets() {
  const loader = new GLTFLoader()
  // GLBs for the 6 player cars + 9 rival cars come from the no-logo pack at
  // public/models/. Asset key = car id, so cloneAsset(car.asset, …) just works.
  const carItems = {}
  for (const c of PLAYER_CARS) carItems[c.asset] = `/models/${c.asset}.glb`
  for (const c of OPPONENT_CARS) carItems[c.asset] = `/models/${c.asset}.glb`
  const items = {
    ...carItems,
    cone: "/models/cone.glb",
    box: "/models/box.glb",
    flagCheckers: "/models/racing/flagCheckers.gltf",
    flagRed: "/models/racing/flagRed.gltf",
    flagGreen: "/models/racing/flagGreen.gltf",
    overhead: "/models/racing/overheadRoundColored.gltf",
    barrierRed: "/models/racing/barrierRed.gltf",
    barrierWhite: "/models/racing/barrierWhite.gltf",
    barrierWall: "/models/racing/barrierWall.gltf",
    pylon: "/models/racing/pylon.gltf",
    rampKit: "/models/racing/ramp.gltf",
    grandStand: "/models/racing/grandStand.gltf",
    treeLarge: "/models/racing/treeLarge.gltf",
    billboard: "/models/racing/billboard.gltf"
  }
  const entries = Object.entries(items)
  const total = entries.length
  let done = 0
  const setProgress = () => {
    // Splash overlay was removed; loading happens silently while the
    // menu HTML is already rendered (the 3D scene populates as models
    // arrive). Kept as a no-op so the loop math below is unchanged.
    void done; void total
  }
  setProgress()
  const results = []
  for (const [k, url] of entries) {
    try {
      const g = await loader.loadAsync(url)
      // ── DIAG: confirm GLB landed and how many vertices it has. ──
      let meshCount = 0
      let vertexCount = 0
      const matSummary = []
      g.scene.traverse((c) => {
        if (c.isMesh) {
          meshCount++
          vertexCount += c.geometry?.attributes?.position?.count ?? 0
          matSummary.push({
            name: c.name || "(unnamed)",
            mat: c.material?.type,
            color: c.material?.color?.getHexString(),
            opacity: c.material?.opacity
          })
        }
      })
      console.log(`[GLB] ${k} from ${url}: ${meshCount} meshes, ${vertexCount} verts, scene.children=${g.scene.children.length}`)
      // Player car assets get full per-mesh material dump — that's where
      // we actually need to verify materials aren't getting clobbered.
      if (k === "race-future" || k === "sedan-sports" || k === "race") {
        console.log(`[GLB-MATS] ${k}:`, matSummary)
      }
      results.push([k, g.scene])
    } catch (e) {
      console.warn("[GLB-FAIL]", url, e)
      results.push([k, null])
    }
    done++
    setProgress()
  }
  assets = Object.fromEntries(results)
}

function cloneAsset(name, targetSize = null, axis = "x") {
  const src = assets[name]
  if (!src) return null
  const clone = src.clone(true)
  clone.traverse((m) => {
    if (m.isMesh && m.material) {
      m.material = m.material.clone()
      m.material.roughness = Math.min(m.material.roughness ?? 0.55, 0.45)
    }
  })
  const box = new THREE.Box3().setFromObject(clone)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  clone.position.sub(center)
  const dim = axis === "z" ? size.z : axis === "y" ? size.y : Math.max(size.x, size.z)
  const scale = targetSize == null ? 1 : targetSize / Math.max(0.001, dim)
  const wrap = new THREE.Group()
  wrap.add(clone)
  wrap.scale.setScalar(scale)
  const wrapBox = new THREE.Box3().setFromObject(wrap)
  wrap.position.y -= wrapBox.min.y
  return wrap
}

// Recolor only the bright body panels of a Kenney car GLB, leaving glass / wheels / lights alone.
// Player paint must stay opaque and non-emissive; glow belongs to the world,
// not to cloned shells or polluted car materials.
// Pre-built dark-rubber tire material reused for every wheel mesh.
// MeshStandardMaterial intentionally — no clearcoat, high roughness so
// they read as matte rubber instead of lacquered chassis panels.
const TIRE_MAT = new THREE.MeshStandardMaterial({
  color: 0x1a1a1a,
  roughness: 0.9,
  metalness: 0.1,
  emissive: 0x000000,
  emissiveIntensity: 0
})
TIRE_MAT.transparent = false
TIRE_MAT.opacity = 1

// Mesh-name pattern that flags a wheel/tire/rim — the Kenney Car Kit GLBs
// export them as "wheel-back-left" / "wheel-front-right" / etc., so a
// simple substring match keeps them out of the body-panel pipeline.
const WHEEL_RE = /wheel|tire|tyre|rim/i

function recolorCar(asset, opts = {}) {
  const body = new THREE.Color(opts.body ?? 0x18b6ff)
  const accent = new THREE.Color(opts.accent ?? 0x081a36)
  asset.traverse((m) => {
    if (!m.isMesh || !m.material) return
    // Wheels: replace with the shared dark-rubber tire material and skip
    // the body-paint pipeline. Without this every wheel mesh got the
    // body colour + clearcoat (Kenney exports them as pure white) — the
    // car came out as a single-toned blob with no chassis/wheel contrast.
    if (m.name && WHEEL_RE.test(m.name)) {
      m.material = TIRE_MAT
      m.castShadow = true
      m.receiveShadow = true
      return
    }
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    for (let i = 0; i < mats.length; i++) {
      const mat = mats[i].clone()
      let isBodyPanel = false
      if (mat.color) {
        const hsl = { h: 0, s: 0, l: 0 }
        mat.color.getHSL(hsl)
        // Body paint: any bright panel (l > 0.35) that isn't a pure
        // saturated colour (the Kenney lights/glass which keep their
        // original look). Tinted white (l ≈ 1, s = 0) panels — the
        // default body of race-future / sedan-sports / race — count.
        if (hsl.l > 0.35) {
          if (hsl.s < 0.55 || hsl.l > 0.55) {
            mat.color.copy(body)
            mat.map = null      // drop Kenney palette texture so paint reads pure
            isBodyPanel = true
          } else {
            mat.color.copy(accent)
          }
        }
      }
      mat.metalness = Math.max(mat.metalness ?? 0.2, 0.6)
      mat.roughness = Math.min(mat.roughness ?? 0.5, 0.28)
      if (mat.emissive) mat.emissive.setHex(0x000000)
      mat.emissiveIntensity = 0
      mat.transparent = false
      mat.opacity = 1
      mat.depthWrite = true
      mats[i] = mat
    }
    m.material = Array.isArray(m.material) ? mats : mats[0]
    m.castShadow = true
    m.receiveShadow = true
  })
}

// Walk a loaded GLB car and upgrade body-panel materials to a clearcoat
// lacquer that catches the bloom + sky reflections. Heuristic: the body
// panels have the largest mesh by triangle count, plus any mesh whose
// material's color reads as "body paint" (mid-luminance, low-saturation
// or saturated mid-tone — same heuristic recolorCar uses). Wheels /
// glass / lights keep their source materials.
function upgradeCarMaterials(asset, opts = {}) {
  const clearcoat = opts.clearcoat ?? 0.8
  const metalness = opts.metalness ?? 0.55
  const roughness = opts.roughness ?? 0.35
  asset.traverse((m) => {
    if (!m.isMesh || !m.material) return
    // Wheels keep the matte rubber material set in recolorCar — no
    // clearcoat, no metalness boost. Without this guard the lacquer
    // pass would override TIRE_MAT and the wheels would shine like
    // body panels again.
    if (m.name && WHEEL_RE.test(m.name)) return
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    for (let i = 0; i < mats.length; i++) {
      const src = mats[i]
      if (!src.color) continue
      const hsl = { h: 0, s: 0, l: 0 }
      src.color.getHSL(hsl)
      // Skip pitch-black (tires) and pure-emissive lights (those usually
      // have non-zero emissiveIntensity). Anything else with mid-bright
      // luminance counts as a body panel that gets the lacquer upgrade.
      // Includes the now-bright-blue panels recolorCar just produced.
      const isLight = (src.emissiveIntensity ?? 0) > 0.5
      const isBody = !isLight && hsl.l > 0.30 && (hsl.s < 0.95 || hsl.l > 0.45)
      if (!isBody) continue
      const next = new THREE.MeshPhysicalMaterial({
        color: src.color.clone(),
        metalness,
        roughness,
        clearcoat,
        clearcoatRoughness: 0.15,
        envMapIntensity: 1.0,
        emissive: new THREE.Color(0x000000),
        emissiveIntensity: 0
      })
      next.transparent = false
      next.opacity = 1
      next.depthWrite = true
      next.userData = next.userData || {}
      next.userData._origEmiH = next.emissive.getHex()
      next.userData._origEmiI = next.emissiveIntensity ?? 0
      mats[i] = next
    }
    m.material = Array.isArray(m.material) ? mats : mats[0]
  })
}

function sanitizePlayerCarMaterials(asset) {
  asset.traverse((m) => {
    if (!m.isMesh || !m.material) return
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    for (const mat of mats) {
      if (!mat) continue
      if (mat.emissive) mat.emissive.setHex(0x000000)
      mat.emissiveIntensity = 0
      mat.transparent = false
      mat.opacity = 1
      mat.depthWrite = true
      mat.envMapIntensity = mat.envMapIntensity ?? 1.0
      mat.needsUpdate = true
    }
    m.castShadow = true
    m.receiveShadow = true
  })
}

function setupPlayerWheelRuntime(car) {
  const rollingWheels = []
  car.traverse((o) => {
    if (o.isMesh && WHEEL_RE.test(o.name || "")) rollingWheels.push(o)
  })
  const steeringPivots = []
  for (const wheelName of ["wheel-front-left", "wheel-front-right"]) {
    const wheel = car.getObjectByName(wheelName)
    if (!wheel || !wheel.parent) continue
    const parent = wheel.parent
    const steeringPivot = new THREE.Group()
    steeringPivot.name = `steering-${wheel.name}`
    steeringPivot.position.copy(wheel.position)
    parent.add(steeringPivot)
    steeringPivot.add(wheel)
    wheel.position.set(0, 0, 0)
    steeringPivots.push(steeringPivot)
  }
  car.userData.rollingWheels = rollingWheels
  car.userData.steeringPivots = steeringPivots
  car.userData.wheelRadius = 0.46
}

// Attach 4 light cubes to the player car: 2 headlights at the nose + 2
// taillights at the tail. These are the ONLY emissive elements on the
// player vehicle — body/wheels stay matte. Brake state per-frame boosts
// taillight emissiveIntensity 0.6 → 2.0 (see updatePlayerCarLights).
function attachCarLights(car) {
  // Find the body mesh (largest non-wheel mesh by vertex count if no
  // mesh is named "body").
  let body = car.getObjectByName("body")
  if (!body) {
    let maxVerts = 0
    car.traverse((c) => {
      if (!c.isMesh || !c.geometry || WHEEL_RE.test(c.name || "")) return
      const v = c.geometry.attributes?.position?.count ?? 0
      if (v > maxVerts) { maxVerts = v; body = c }
    })
  }
  if (!body) return
  body.geometry.computeBoundingBox()
  const bb = body.geometry.boundingBox
  const halfW = (bb.max.x - bb.min.x) * 0.32           // x offset from centreline
  const yMid  = bb.min.y + (bb.max.y - bb.min.y) * 0.55
  // GLB nose is at -Z, tail is at +Z (the playerBody-level rotateY(Math.PI)
  // flips this when the car renders, but as a child of `body` the lights
  // ride that flip transparently).
  const noseZ = bb.min.z + 0.05
  const tailZ = bb.max.z - 0.05

  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff5cc, emissive: 0xffeeaa, emissiveIntensity: 1.5
  })
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x330000, emissive: 0xff0000, emissiveIntensity: 0.6
  })
  const headlights = []
  const taillights = []
  for (const sx of [-halfW, halfW]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, 0.05), headMat.clone())
    head.position.set(sx, yMid, noseZ)
    body.add(head)
    headlights.push(head)
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.08, 0.04), tailMat.clone())
    tail.position.set(sx, yMid, tailZ)
    body.add(tail)
    taillights.push(tail)
  }
  car.userData.headlights = headlights
  car.userData.taillights = taillights
}

// Per-frame brake-light boost. Smoothly interpolates emissiveIntensity
// 0.6 ↔ 2.0 based on state.brake. Only touches taillights — never body
// or wheel materials, so the no-emissive-on-body invariant holds.
function updatePlayerCarLights() {
  const tails = playerBody?.userData?.taillights
  if (!tails) return
  const target = state.brake ? 2.0 : 0.6
  for (const t of tails) {
    t.material.emissiveIntensity = lerp(t.material.emissiveIntensity, target, 0.3)
  }
}

function auditPlayerCarRuntime() {
  const result = { meshCount: 0, materials: {} }
  if (!playerBody) return result
  playerBody.traverse((c) => {
    if (!c.isMesh) return
    result.meshCount++
    if (!c.name || !c.material) return
    const mat = Array.isArray(c.material) ? c.material[0] : c.material
    result.materials[c.name] = {
      em: mat.emissive?.getHexString?.(),
      ei: mat.emissiveIntensity,
      t: mat.transparent,
      o: mat.opacity
    }
  })
  return result
}

function tintAsset(asset, color, accent) {
  asset.traverse((m) => {
    if (!m.isMesh || !m.material) return
    const c = new THREE.Color(color)
    if (m.material.color) {
      const old = m.material.color.getHex()
      // keep darks (tires, glass) intact, only tint bright body parts
      if (old > 0x444444) m.material.color.copy(c)
    }
    m.material.metalness = 0.55
    m.material.roughness = 0.32
    if (accent !== undefined && m.material.emissive) {
      m.material.emissive.setHex(accent)
      m.material.emissiveIntensity = 0.18
    }
  })
}

// ────────────────────────────────────────────────────────────────────
// sky / scenery
// ────────────────────────────────────────────────────────────────────
// Make a sky-dome texture from a list of [stop, hex] pairs. Used once at
// init for the default mood and again when applyTrack swaps the palette
// per level (sunset / noon / overcast / neon / midnight rain).
function makeSkyTexture(stops) {
  const c = document.createElement("canvas")
  c.width = 16
  c.height = 256
  const g = c.getContext("2d")
  const grd = g.createLinearGradient(0, 0, 0, 256)
  for (const [stop, hex] of stops) grd.addColorStop(stop, hex)
  g.fillStyle = grd
  g.fillRect(0, 0, 16, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// Per-level palette: gradient stops for the sky dome, fog colour, fog
// near/far. applyTrack reads this and re-paints the dome on level change.
const LEVEL_SKY = {
  lv1: {
    label: "sunset",
    stops: [[0.00, "#0f1846"], [0.30, "#3a2f8a"], [0.55, "#ff6b3d"], [0.78, "#ffb04a"], [1.00, "#ffe17a"]],
    fog: [0xff8a55, 220, 760],
    cloud: 0xffd8b0
  },
  lv2: {
    label: "noon",
    stops: [[0.00, "#3b8de8"], [0.45, "#7fc1f4"], [0.85, "#cdeafd"], [1.00, "#f4faff"]],
    fog: [0xb6dcfc, 280, 880],
    cloud: 0xffffff
  },
  lv3: {
    label: "overcast",
    stops: [[0.00, "#3a4458"], [0.45, "#5a6478"], [0.85, "#8a94a8"], [1.00, "#b0bac8"]],
    fog: [0x8a94a8, 180, 620],
    cloud: 0xc8d0d8
  },
  lv4: {
    label: "neon-purple",
    stops: [[0.00, "#1a0a3a"], [0.45, "#5e1ea2"], [0.75, "#b24aff"], [1.00, "#ff7adf"]],
    fog: [0x5e1ea2, 160, 560],
    cloud: 0xc8a4ff
  },
  lv5: {
    label: "midnight-rain",
    stops: [[0.00, "#020410"], [0.55, "#08142a"], [1.00, "#1a2540"]],
    fog: [0x040814, 90, 380],
    cloud: 0x3a4860
  }
}

function buildSky() {
  // Default backdrop is the lv1 sunset palette — applyTrack swaps it once
  // a level loads. Reused across the 5 tracks via texture replacement.
  const geo = new THREE.SphereGeometry(900, 32, 16)
  const tex = makeSkyTexture(LEVEL_SKY.lv1.stops)
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false }))
  scene.add(dome)
  skyDome = dome

  // a few drifting clouds — warm-tinted to read against the sunset sky
  for (let i = 0; i < 24; i++) {
    const cl = makeCloud()
    cl.position.set(rand(-260, 260), rand(40, 90), rand(-1200, 200))
    cl.scale.setScalar(rand(0.8, 2.2))
    world.add(cl)
  }
}

function makeCloud() {
  const g = new THREE.Group()
  // warm peach tint picks up sunset lighting from the dome behind
  const m = new THREE.MeshBasicMaterial({ color: 0xffd8b0, transparent: true, opacity: 0.78, fog: false })
  for (const [x, y, s] of [[-1.4, 0, 1.1], [-0.3, 0.3, 1.4], [0.9, 0.05, 1], [1.7, -0.05, 0.75]]) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(s, 14, 10), m)
    b.position.set(x, y, 0)
    g.add(b)
  }
  return g
}

// ────────────────────────────────────────────────────────────────────
// track
// ────────────────────────────────────────────────────────────────────
// Build a curved CatmullRom centerline for the selected track. Track-space
// progress (meters from start, increasing) maps to world position via
// progressToWorld(). Each track has its own bend amplitude / hill profile.
function buildTrackCurve() {
  const lvl = state.level
  const tCfg = TRACKS[lvl?.trackStyle ?? Save.get().selectedTrack] ?? TRACKS.sky
  const totalLen = lvl?.length ?? tCfg.length
  const points = []
  // start: 24m back from origin so the start gantry has space behind player
  points.push(new THREE.Vector3(0, 0, 24))
  // bend multiplier: level.bend = 0.2 means tutorial-style near-straight,
  // level.bend = 1.2 means twistier neon city-night track.
  const bendMul = lvl?.bend ?? 1
  // Track curvature was too gentle to read as actual turns at race speed.
  // Bumped baseWobble across all tracks ~2.5x so the spline produces
  // visible left/right sweepers instead of a near-straight line.
  const baseWobble = tCfg.id === "neon" ? 80 : tCfg.id === "sunset" ? 65 : 50
  const baseHills = tCfg.id === "neon" ? 3.6 : tCfg.id === "sunset" ? 2.8 : 2.0
  const wobble = baseWobble * bendMul
  const hills = baseHills * bendMul
  // sample control points every ~70m
  const step = 70
  let z = 0
  while (z > -totalLen) {
    z -= step
    const s = -z   // distance from origin
    const x =
      Math.sin(s * 0.0085) * wobble +
      Math.sin(s * 0.0033 + 1.2) * (wobble * 0.4)
    const y = Math.sin(s * 0.0072 + 0.5) * hills + Math.sin(s * 0.0028) * (hills * 0.4)
    points.push(new THREE.Vector3(x, y, z))
  }
  // tail past finish so end-of-track tangent is well-defined
  points.push(new THREE.Vector3(0, 0, -totalLen - 50))
  Track.curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5)
  Track.length = Track.curve.getLength()
  CFG.trackLength = Track.length
}

// Track-space (progress, lateral, height) → world coordinates.
function progressToWorld(progress, lateral = 0, height = 0, out = new THREE.Vector3()) {
  const t = clamp(progress / Track.length, 0, 1)
  Track.curve.getPointAt(t, out)
  Track.curve.getTangentAt(t, Track._tan)
  Track._right.crossVectors(Track._up, Track._tan).normalize()
  out.addScaledVector(Track._right, lateral)
  out.y += height
  return out
}

// Track-space tangent (forward direction) at a given progress.
function progressTangent(progress, out = new THREE.Vector3()) {
  const t = clamp(progress / Track.length, 0, 1)
  Track.curve.getTangentAt(t, out)
  return out
}

function buildTrack() {
  track.clear()
  buildTrackCurve()

  const samples = Math.max(80, Math.floor(Track.length / 4))
  const halfW = CFG.roadHalfWidth
  const laneHalf = CFG.laneHalfWidth
  const edgeW = halfW - laneHalf

  // build a single-ribbon mesh for the lane area (yellow center)
  // and 2 ribbon meshes for the blue edges, all bent along the spline.
  track.add(makeRibbonMesh(samples, -laneHalf, laneHalf, 0.36, mats.roadCenter, Track.length / 24))
  track.add(makeRibbonMesh(samples, -halfW, -laneHalf, 0.36, mats.roadEdgeR, Track.length / 18))
  track.add(makeRibbonMesh(samples, laneHalf, halfW, 0.36, mats.roadEdge, Track.length / 18))

  // rails (blue body + yellow top) on each side
  for (const side of [-1, 1]) {
    track.add(makeRailMesh(samples, side * (halfW + 0.21), 0.65, 0.42, 0.95, mats.rail))
    track.add(makeRailMesh(samples, side * (halfW + 0.21), 1.18, 0.46, 0.18, mats.railTop))
  }

  // structural underside ribs every ~24m. Box dimension is along the local
  // axes after lookAt: width along X = road width, depth along Z = thickness.
  // Use a smaller, slimmer profile so they don't fight the curve geometry.
  const ribStep = 24
  for (let s = 12; s < Track.length; s += ribStep) {
    const center = progressToWorld(s, 0, -0.9)
    const tan = progressTangent(s).clone()
    const right = new THREE.Vector3().crossVectors(Track._up, tan).normalize()
    // build rib as a flat horizontal beam along `right` axis
    const ribGeo = new THREE.BoxGeometry(halfW * 2 + 1.0, 0.8, 0.8)
    const rib = new THREE.Mesh(ribGeo, mats.support)
    rib.position.copy(center)
    // align local +X with `right` direction
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), tan, Track._up)
    rib.setRotationFromMatrix(m)
    track.add(rib)
  }

  // Bright dashed lane markings — ONE row down the centre, plus two rows
  // separating the 3 lanes. Spacing 5m, 1.6m long × 0.32m wide × 0.05
  // tall, emissive 0.6 so they read as glowing in the dusk lighting.
  // Triple density vs. before — they rip past the camera at speed and
  // are the biggest single contributor to sense-of-velocity.
  const dashMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.6,
    roughness: 0.5
  })
  for (let s = 5; s < Track.length - 5; s += 5) {
    const tan = progressTangent(s).clone()
    // Centre line (between the middle lane and the right lane), and a
    // mirrored line between left + middle.
    for (const offX of [-1.8, 1.8]) {
      const pos = progressToWorld(s, offX, 0.23)
      const dash = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.05, 1.6), dashMat)
      dash.position.copy(pos)
      dash.lookAt(pos.clone().add(tan))
      track.add(dash)
    }
  }

  // big start-line zebra stripe + periodic narrower stripes.
  // Periodic stripes used to be #1392ff bright sky-blue plates 9.6m
  // wide × 1.2m deep every 64m — at low view angle they tiled across
  // the camera and made the entire road LOOK pale blue. Now subtle
  // dark accents that blend with the asphalt; the start line stays
  // bright cyan so it reads as a finishable / ceremonial marker.
  for (let s = 6; s < Track.length; s += 64) {
    const isStart = s === 6
    const wide = isStart ? 3.4 : 1.2
    const stripeMat = isStart
      ? new THREE.MeshStandardMaterial({ color: 0x26d6ff, emissive: 0x0a4a8a, emissiveIntensity: 0.35, roughness: 0.35 })
      : new THREE.MeshStandardMaterial({ color: 0x2a3a52, roughness: 0.85 })
    const center = progressToWorld(s, 0, 0.21)
    const tan = progressTangent(s).clone()
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(laneHalf * 2 - 0.4, 0.06, wide), stripeMat)
    stripe.position.copy(center)
    stripe.lookAt(center.clone().add(tan))
    track.add(stripe)
  }

  // start gantry — placed behind the start grid (progress = -8, ie. behind start)
  const startGantry = makeOverheadGantry(0xfff15a, 0xffce15, true)
  placeAlongTrack(startGantry, -8)
  track.add(startGantry)

  // welcome arch 16m past the start grid
  const welcomeArch = makeOverheadGantry(0x10c8ff, 0xfff15a, false)
  placeAlongTrack(welcomeArch, 32)
  track.add(welcomeArch)

  // finish line at end of track
  const finish = makeFinishLine()
  placeAlongTrack(finish, Track.length - 30)
  track.add(finish)
}

// Place an Object3D along the track at a given progress, lateral=0, oriented
// to face forward along the tangent.
function placeAlongTrack(obj, progress, lateral = 0, height = 0) {
  const pos = progressToWorld(progress, lateral, height)
  const tan = progressTangent(progress).clone()
  obj.position.copy(pos)
  obj.lookAt(pos.clone().add(tan))
}

// Build a ribbon mesh (a strip of width [u0..u1]) along the spline. The
// texture map repeats vertically by `repeatV`.
function makeRibbonMesh(samples, u0, u1, thickness, material, repeatV) {
  const verts = []
  const uvs = []
  const idx = []
  const tmpRight = new THREE.Vector3()
  const tmpTan = new THREE.Vector3()
  const tmpPos = new THREE.Vector3()
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    Track.curve.getPointAt(t, tmpPos)
    Track.curve.getTangentAt(t, tmpTan)
    tmpRight.crossVectors(Track._up, tmpTan).normalize()
    // top of strip (slight thickness using +y, simpler than a real box)
    const yTop = tmpPos.y + thickness * 0.5
    const lx = tmpPos.x + tmpRight.x * u0
    const lz = tmpPos.z + tmpRight.z * u0
    const rx = tmpPos.x + tmpRight.x * u1
    const rz = tmpPos.z + tmpRight.z * u1
    verts.push(lx, yTop, lz, rx, yTop, rz)
    uvs.push(0, t * repeatV, 1, t * repeatV)
    if (i < samples) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  // ribbon shares the material — make sure repeat is set so the texture tiles
  if (material.map) {
    material.map.wrapS = THREE.RepeatWrapping
    material.map.wrapT = THREE.RepeatWrapping
  }
  return new THREE.Mesh(geo, material)
}

// Build a thin vertical rail mesh along the spline (rectangular cross-section).
function makeRailMesh(samples, lateral, yCenter, w, h, material) {
  const verts = []
  const idx = []
  const tmpRight = new THREE.Vector3()
  const tmpTan = new THREE.Vector3()
  const tmpPos = new THREE.Vector3()
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    Track.curve.getPointAt(t, tmpPos)
    Track.curve.getTangentAt(t, tmpTan)
    tmpRight.crossVectors(Track._up, tmpTan).normalize()
    const cx = tmpPos.x + tmpRight.x * lateral
    const cz = tmpPos.z + tmpRight.z * lateral
    const rx = tmpRight.x * (w * 0.5)
    const rz = tmpRight.z * (w * 0.5)
    const yLow = tmpPos.y + yCenter - h * 0.5
    const yHi = tmpPos.y + yCenter + h * 0.5
    // 4 verts per cross-section: front-left, front-right, back-right, back-left (in cross-section)
    verts.push(
      cx - rx, yLow, cz - rz,    // 0 lower-inner
      cx + rx, yLow, cz + rz,    // 1 lower-outer
      cx + rx, yHi, cz + rz,     // 2 upper-outer
      cx - rx, yHi, cz - rz      // 3 upper-inner
    )
    if (i < samples) {
      const a = i * 4
      // 4 quads connecting this cross-section to the next: top, outer, bottom, inner
      idx.push(
        a + 3, a + 2, a + 7, a + 7, a + 2, a + 6,    // top
        a + 1, a + 5, a + 2, a + 2, a + 5, a + 6,    // outer
        a + 0, a + 4, a + 1, a + 1, a + 4, a + 5,    // bottom
        a + 3, a + 7, a + 0, a + 0, a + 7, a + 4     // inner
      )
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return new THREE.Mesh(geo, material)
}

function makeOverheadGantry(topColor = 0xffce15, accent = 0x10c8ff, withLight = false) {
  const asset = cloneAsset("overhead", 10, "x")
  if (asset) {
    tagObstacle(asset, withLight ? "checkpoint-gate" : "finish-gate", "overhead")
    return asset
  }
  console.warn("[obstacle-glb] Failed to load overhead gate, fallback to placeholder")
  const g = new THREE.Group()
  g.userData.isFallback = true
  const w = CFG.roadHalfWidth + 1
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.55, 7.4, 0.55), mats.support)
    leg.position.set(side * w, 3.7, 0)
    g.add(leg)
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 2 + 0.8, 1.0, 0.8), new THREE.MeshStandardMaterial({ color: topColor, metalness: 0.4, roughness: 0.3 }))
  beam.position.set(0, 7.0, 0)
  g.add(beam)

  // banner panel
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.7, 1.4), mats.banner)
  panel.position.set(0, 7.0, 0.42)
  g.add(panel)
  const panelBack = panel.clone()
  panelBack.position.z = -0.42
  panelBack.rotation.y = Math.PI
  g.add(panelBack)

  // lights row
  for (let i = -3; i <= 3; i++) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshStandardMaterial({ color: 0xfff7d6, emissive: 0xfff2b1, emissiveIntensity: 1.2 }))
    lamp.position.set(i * 1.7, 6.4, 0)
    g.add(lamp)
  }

  if (withLight) {
    const greenLight = new THREE.Mesh(new THREE.SphereGeometry(0.7, 18, 12), new THREE.MeshStandardMaterial({ color: 0x6fff37, emissive: 0x35dc0d, emissiveIntensity: 1.5 }))
    greenLight.position.set(-3.4, 8.0, 0)
    g.add(greenLight)
    const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.6, 10), mats.support)
    flagPole.position.set(3.2, 8.4, 0)
    g.add(flagPole)
    const flag = cloneAsset("flagCheckers", 1.8) || new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.0), mats.checker)
    flag.position.set(3.2, 8.6, 0.1)
    g.add(flag)
  }
  return g
}

function tagObstacle(obj, kind, asset) {
  obj.userData = {
    ...obj.userData,
    isObstacle: true,
    obstacleKind: kind,
    obstacleAsset: asset
  }
  obj.traverse((c) => {
    c.userData = {
      ...c.userData,
      isObstacle: true,
      obstacleKind: kind,
      obstacleAsset: asset
    }
  })
  return obj
}

function makeObstacleFallback(kind) {
  console.warn(`[obstacle-glb] Failed to load ${kind}, fallback to placeholder`)
  const fallback = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1, 8),
    new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.8 })
  )
  fallback.position.y = 0.5
  fallback.userData.isFallback = true
  return tagObstacle(fallback, kind, "fallback")
}

function makeFinishLine() {
  const g = new THREE.Group()
  // checkered ground stripe
  for (let x = -CFG.laneHalfWidth; x < CFG.laneHalfWidth; x += 1.4) {
    for (let z = -2.4; z < 2.4; z += 1.4) {
      const idx = Math.round((x + z) * 0.7)
      const c = idx % 2 ? 0x111111 : 0xffffff
      const tile = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 1.4), new THREE.MeshStandardMaterial({ color: c, roughness: 0.45 }))
      tile.position.set(x + 0.7, 0.21, z)
      g.add(tile)
    }
  }
  // arch with checkered banner
  const arch = makeOverheadGantry(0x10c8ff, 0x10c8ff, false)
  g.add(arch)
  const checker = new THREE.Mesh(new THREE.PlaneGeometry(CFG.roadHalfWidth * 2 + 1.6, 1.6), new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.4 }))
  checker.position.set(0, 5.4, 0)
  g.add(checker)
  // big yellow goalposts behind
  const goalMat = new THREE.MeshStandardMaterial({ color: 0xffcc1a, metalness: 0.5, roughness: 0.3 })
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 11, 18), goalMat)
    post.position.set(s * (CFG.roadHalfWidth + 1.6), 5.5, -1)
    g.add(post)
  }
  return g
}

// ────────────────────────────────────────────────────────────────────
// scenery (turbines, towers, balls, billboards)
// ────────────────────────────────────────────────────────────────────
function buildScenery() {
  // remove any scenery placed by a prior race (tagged with userData.isScenery)
  for (let i = world.children.length - 1; i >= 0; i--) {
    if (world.children[i].userData?.isScenery) world.remove(world.children[i])
  }
  const sceneryAdd = (obj) => { obj.userData.isScenery = true; world.add(obj) }
  // ground far below the road (so the track feels suspended in the sky)
  // Ground plane 60u below the track. Was sky-blue #4d8bc4 — when the
  // camera looked at the horizon it produced a pale blue band that
  // overlapped the road silhouette and bled a "light blue road" feel.
  // Now dark slate so it disappears into the dusk fog.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4400, 4400),
    new THREE.MeshStandardMaterial({ color: 0x121828, roughness: 0.95 })
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.set(0, -60, -Track ? -Track.length / 2 : -700)
  sceneryAdd(ground)

  const trackId = Save.get().selectedTrack
  const isNight = trackId === "neon"

  // ─── light poles every 24m along both sides ───
  // Trade-off: dense vertical objects rushing past = strong speed cue,
  // but 12m spacing × 2 sides × 200 poles each side = 400 emissive
  // meshes through the bloom pass — enough to tank the WebGL
  // pipeline and produce a black frame. 24m is dense enough to read
  // as a wall of lights at speed without blowing the GPU budget.
  for (let s = 24; s < Track.length; s += 24) {
    for (const sd of [-1, 1]) {
      const pole = makeLightPole(isNight)
      const pos = progressToWorld(s, sd * (CFG.roadHalfWidth + 1.6), 0)
      pole.position.copy(pos)
      // face the pole "towards" the road
      const tan = progressTangent(s).clone()
      pole.lookAt(pos.clone().add(tan))
      pole.rotateY(sd > 0 ? Math.PI / 2 : -Math.PI / 2)
      sceneryAdd(pole)
    }
  }

  // ─── neon billboards every 220m, alternating sides — fictional racing brands ───
  const billboardLines = ["LIGHTNING", "NEON RACE", "SPEED ZONE", "TURBO", "CIRCUIT", "VICTORY LANE"]
  for (let i = 0; i * 220 < Track.length; i++) {
    const s = 160 + i * 220
    if (s >= Track.length) break
    const side = i % 2 ? -1 : 1
    const board = makeBillboard(billboardLines[i % billboardLines.length], i % 3 === 0 ? 0xff2a90 : (i % 3 === 1 ? 0x26d6ff : 0xffd31a))
    const pos = progressToWorld(s, side * (CFG.roadHalfWidth + 9), 5.4)
    board.position.copy(pos)
    const tan = progressTangent(s).clone()
    board.lookAt(pos.clone().add(tan))
    board.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2)
    sceneryAdd(board)
  }

  // ─── city silhouettes on BOTH sides of every track ──────────────────
  // Cyberpunk-style buildings unify with the main-menu art direction.
  // Night tracks get a denser skyline (skipping the offset turbines),
  // daytime tracks still get a respectable line of glowing-window towers
  // a little further from the road so the racing surface stays readable.
  const cityCount = isNight ? 44 : 28
  const baseDist = isNight ? 60 : 75
  for (let i = 0; i < cityCount; i++) {
    const sd = i % 2 ? -1 : 1
    const s = 30 + i * (isNight ? 56 : 78)
    if (s >= Track.length) break
    // jitter distance + height so the skyline doesn't read as a rhythmic ladder
    const dist = baseDist + (i % 5) * 18 + (sd > 0 ? 6 : 0)
    const h = 18 + (i * 7) % 38
    const w = 8 + (i % 4) * 3
    const buildings = makeCityBlock(w, h, i)
    const pos = progressToWorld(s, sd * (CFG.roadHalfWidth + dist), 0)
    buildings.position.copy(pos)
    const tan = progressTangent(s).clone()
    buildings.lookAt(pos.clone().add(tan))
    sceneryAdd(buildings)
  }

  // turbines + trusses placed along the curve: every ~80m, alternating sides,
  // so they follow the track instead of drifting off into nothing.
  const turbineCount = isNight ? 0 : Math.floor(Track.length / 90)
  for (let i = 0; i < turbineCount; i++) {
    const fan = makeTurbine(i)
    const side = i % 2 ? -1 : 1
    const s = 60 + i * 90
    if (s >= Track.length) break
    const pos = progressToWorld(s, side * (CFG.roadHalfWidth + 36 + (i % 3) * 6), 4.5)
    fan.position.copy(pos)
    sceneryAdd(fan)
  }

  // signature floating ring + ball right at the start (only daytime tracks)
  if (!isNight) {
    const startBall = makeFloatingBall()
    const startBallPos = progressToWorld(2, CFG.roadHalfWidth + 4, 4.4)
    startBall.position.copy(startBallPos)
    startBall.scale.setScalar(0.85)
    sceneryAdd(startBall)
    // floating balls along the route
    for (let i = 0; i < 12; i++) {
      const ball = makeFloatingBall()
      const side = i % 2 ? -1 : 1
      const s = 120 + i * 140
      if (s >= Track.length) break
      const pos = progressToWorld(s, side * (CFG.roadHalfWidth + 14 + rand(0, 8)), 11 + rand(0, 6))
      ball.position.copy(pos)
      sceneryAdd(ball)
    }
  }

  // truss towers along the curve (skipped at night — billboards take their place)
  const towerCount = isNight ? 0 : Math.floor(Track.length / 80)
  for (let i = 0; i < towerCount; i++) {
    const tower = makeTower(i)
    const side = i % 2 ? -1 : 1
    const s = 90 + i * 80
    if (s >= Track.length) break
    const pos = progressToWorld(s, side * (CFG.roadHalfWidth + 24 + (i % 3) * 6), 0)
    tower.position.copy(pos)
    sceneryAdd(tower)
  }

  // grandstand at start
  const stand = cloneAsset("grandStand", 22, "z")
  if (stand) {
    stand.position.set(-50, -8, -10)
    stand.rotation.y = Math.PI / 2
    sceneryAdd(stand)
    const stand2 = stand.clone(true)
    stand2.position.set(50, -8, -10)
    stand2.rotation.y = -Math.PI / 2
    sceneryAdd(stand2)
  }

  // trees scattered along the curve at the track edges
  for (let i = 0; i < 14; i++) {
    const tree = cloneAsset("treeLarge", 5)
    if (!tree) break
    const side = i % 2 ? -1 : 1
    const s = 40 + i * 110
    if (s >= Track.length) break
    const pos = progressToWorld(s, side * (CFG.roadHalfWidth + 10 + rand(0, 4)), -2)
    tree.position.copy(pos)
    sceneryAdd(tree)
  }
}

// ─── Light pole with a glowing ball ───
function makeLightPole(isNight) {
  const g = new THREE.Group()
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 6.5, 8), new THREE.MeshStandardMaterial({ color: 0x202838, roughness: 0.5 }))
  post.position.y = 3.25
  g.add(post)
  // arm reaching toward the road
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8), new THREE.MeshStandardMaterial({ color: 0x202838 }))
  arm.rotation.z = Math.PI / 2
  arm.position.set(0.6, 6.4, 0)
  g.add(arm)
  // glowing lamp head
  const lampColor = isNight ? 0xfff5b8 : 0xffffff
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 12, 8),
    new THREE.MeshStandardMaterial({
      color: lampColor,
      emissive: lampColor,
      emissiveIntensity: isNight ? 1.4 : 0.4
    })
  )
  lamp.position.set(1.2, 6.4, 0)
  g.add(lamp)
  // No per-pole PointLight: with poles every 12m × 2 sides we'd be
  // spawning hundreds of dynamic lights and tank the GPU. The emissive
  // material at intensity 1.4 catches the existing UnrealBloomPass
  // and reads as a luminous lamp on its own.
  return g
}

// ─── Neon billboard with painted text and glowing border ───
function makeBillboard(text, accentHex) {
  const g = new THREE.Group()
  const w = 9
  const h = 4
  // posts
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 5.4, 0.2), new THREE.MeshStandardMaterial({ color: 0x101828 }))
    post.position.set(sx * (w / 2 - 0.4), -2.7, 0)
    g.add(post)
  }
  // canvas-painted board with text
  const c = document.createElement("canvas")
  c.width = 1024
  c.height = 256
  const ctx = c.getContext("2d")
  const bg = ctx.createLinearGradient(0, 0, 0, 256)
  bg.addColorStop(0, "#0a1428")
  bg.addColorStop(1, "#1a2a48")
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, 1024, 256)
  // accent stripe
  ctx.fillStyle = "#" + accentHex.toString(16).padStart(6, "0")
  ctx.fillRect(0, 220, 1024, 6)
  ctx.fillRect(0, 30, 1024, 4)
  // big neon text
  ctx.font = "bold 130px Arial Black, sans-serif"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.shadowColor = "#" + accentHex.toString(16).padStart(6, "0")
  ctx.shadowBlur = 36
  ctx.fillStyle = "#fff"
  ctx.fillText(text, 512, 128)
  ctx.shadowBlur = 0
  // small "RACE NIGHT" tagline
  ctx.font = "bold 26px Arial, sans-serif"
  ctx.fillStyle = "#" + accentHex.toString(16).padStart(6, "0")
  ctx.fillText("• RACE NIGHT •", 512, 200)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({
      map: tex,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 0.95,
      roughness: 0.45
    })
  )
  board.position.set(0, 0, 0)
  g.add(board)
  // back so it doesn't look hollow from behind
  const back = board.clone()
  back.rotation.y = Math.PI
  back.position.z = -0.08
  g.add(back)
  // neon outline frame
  const frame = new THREE.Mesh(
    new THREE.RingGeometry(0, 0, 0),
    new THREE.MeshBasicMaterial({ color: accentHex, transparent: true, opacity: 0.7 })
  )
  // simple bordered shape with 4 thin boxes
  const borderMat = new THREE.MeshBasicMaterial({ color: accentHex, transparent: true, opacity: 0.85 })
  const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.12, 0.06), borderMat)
  top.position.set(0, h / 2, 0.06)
  const bot = top.clone(); bot.position.y = -h / 2
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.12, h, 0.06), borderMat)
  left.position.set(-w / 2, 0, 0.06)
  const right = left.clone(); right.position.x = w / 2
  g.add(top, bot, left, right)
  return g
}

// ─── Distant city block silhouette: tall dark boxes with random lit windows ───
function makeCityBlock(width, height, seed = 0) {
  const g = new THREE.Group()
  const buildingMat = new THREE.MeshStandardMaterial({ color: 0x07112a, roughness: 0.9 })
  // create canvas for window pattern
  const c = document.createElement("canvas")
  c.width = 64
  c.height = 128
  const ctx = c.getContext("2d")
  ctx.fillStyle = "#040816"
  ctx.fillRect(0, 0, 64, 128)
  // random lit windows
  const palette = ["#fff5a8", "#a8d4ff", "#ff8a44", "#94f0ff"]
  for (let y = 8; y < 128; y += 8) {
    for (let x = 4; x < 64; x += 8) {
      if (Math.random() < 0.42) {
        ctx.fillStyle = palette[Math.floor(Math.random() * palette.length)]
        ctx.globalAlpha = 0.7 + Math.random() * 0.3
        ctx.fillRect(x, y, 4, 4)
      }
    }
  }
  ctx.globalAlpha = 1
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(1, height / 16)
  const litMat = new THREE.MeshStandardMaterial({
    map: tex,
    emissive: 0xffffff,
    emissiveMap: tex,
    emissiveIntensity: 0.55
  })
  const main = new THREE.Mesh(new THREE.BoxGeometry(width, height, width * 0.7), litMat)
  main.position.y = height / 2
  g.add(main)
  // top antenna for tall buildings
  if (height > 30) {
    const ant = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 4, 6),
      new THREE.MeshStandardMaterial({ color: 0xff3a3a, emissive: 0xff0a0a, emissiveIntensity: 1.2 })
    )
    ant.position.y = height + 2
    g.add(ant)
  }
  // Roof neon: emissive crowns give skyline colour without adding dynamic
  // PointLights to the render pipeline.
  if ((seed % 3) === 1) {
    const palette = [0xff3aa6, 0x26d6ff, 0xb24aff, 0x5cff8a]
    const c = palette[seed % palette.length]
    const crownGeo = new THREE.BoxGeometry(width * 0.95, 0.6, width * 0.65)
    const crownMat = new THREE.MeshStandardMaterial({
      color: c, emissive: c, emissiveIntensity: 1.4, roughness: 0.4
    })
    const crown = new THREE.Mesh(crownGeo, crownMat)
    crown.position.y = height + 0.4
    g.add(crown)
  }
  return g
}

function makeTurbine(seed) {
  const g = new THREE.Group()
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 12, 16), mats.support)
  base.position.y = 6
  g.add(base)
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1, 16), mats.support)
  hub.rotation.z = Math.PI / 2
  hub.position.set(0, 12, 0.2)
  g.add(hub)
  const fan = new THREE.Group()
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6.4, 0.6), new THREE.MeshStandardMaterial({ color: 0xffd31a, roughness: 0.4 }))
    blade.position.set(0, 3.2, 0)
    blade.geometry.translate(0, -3.2, 0)
    blade.geometry.translate(0, 3.2, 0)
    const slot = new THREE.Group()
    slot.add(blade)
    slot.rotation.z = (i / 3) * tau
    fan.add(slot)
  }
  fan.position.set(0, 12, 0.6)
  fan.userData.spin = 0.4 + (seed % 3) * 0.15
  g.add(fan)
  g.userData.fan = fan
  return g
}

function makeFloatingBall() {
  const g = new THREE.Group()
  const ballMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 })
  const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6, 1), ballMat)
  ball.material.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      "#include <output_fragment>",
      `vec3 dir = normalize(vWorldPosition - cameraPosition);
       float spot = step(0.7, abs(dot(normalize(vNormal), vec3(0,1,0))));
       diffuseColor.rgb = mix(vec3(1.0), vec3(0.0,0.0,0.0), spot);
       #include <output_fragment>`
    )
  }
  g.add(ball)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.08, 12, 32), new THREE.MeshStandardMaterial({ color: 0xffd02e, emissive: 0xffae0e, emissiveIntensity: 0.6 }))
  ring.rotation.x = Math.PI / 2
  g.add(ring)
  g.userData.bobSeed = Math.random() * 10
  return g
}

// Industrial square truss tower, like the bright yellow lattice frames in
// the reference screenshot. Box-frame footprint with cross-bracing X bars.
function makeTower(seed) {
  const g = new THREE.Group()
  const yellow = new THREE.MeshStandardMaterial({ color: 0xffd02e, roughness: 0.42, metalness: 0.25 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x142036, roughness: 0.55 })
  const W = 3.2 + (seed % 3) * 0.4
  const H = 12 + (seed % 4) * 2
  const segH = 2.4
  // 4 vertical legs
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.32, H, 0.32), yellow)
      leg.position.set(sx * W / 2, H / 2, sz * W / 2)
      g.add(leg)
    }
  }
  // horizontal bands every segH metres + diagonal X bracing
  for (let h = segH; h <= H; h += segH) {
    // band rectangle (4 horizontal beams)
    for (const sx of [-1, 1]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(W + 0.32, 0.18, 0.18), yellow)
      beam.position.set(0, h, sx * W / 2)
      g.add(beam)
      const beam2 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, W + 0.32), yellow)
      beam2.position.set(sx * W / 2, h, 0)
      g.add(beam2)
    }
    // diagonal X on front and back faces
    for (const sz of [-1, 1]) {
      const diag = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(W, segH), 0.14, 0.14), yellow)
      diag.position.set(0, h - segH / 2, sz * W / 2)
      diag.rotation.z = Math.atan2(segH, W)
      g.add(diag)
      const diag2 = diag.clone()
      diag2.rotation.z = -Math.atan2(segH, W)
      g.add(diag2)
    }
  }
  // base plate
  const base = new THREE.Mesh(new THREE.BoxGeometry(W + 1.2, 0.3, W + 1.2), dark)
  base.position.set(0, 0.15, 0)
  g.add(base)
  // top platform with star/light
  const top = new THREE.Mesh(new THREE.BoxGeometry(W + 0.8, 0.22, W + 0.8), dark)
  top.position.set(0, H + 0.11, 0)
  g.add(top)
  // tower-top star/light
  const starMat = new THREE.MeshStandardMaterial({
    color: 0xffe45a,
    emissive: 0xffae0e,
    emissiveIntensity: 1.2,
    roughness: 0.3
  })
  const star = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), starMat)
  star.position.set(0, H + 0.55, 0)
  g.add(star)
  return g
}

// ────────────────────────────────────────────────────────────────────
// player car — uses selected car from save state
// ────────────────────────────────────────────────────────────────────
function buildPlayer() {
  player = new THREE.Group()
  scene.add(player)
  rebuildPlayerCar()

  const fakeShadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.4, 32),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.35,
      depthWrite: false
    })
  )
  fakeShadow.name = "player-fake-shadow"
  fakeShadow.rotation.x = -Math.PI / 2
  fakeShadow.position.y = 0.02
  player.add(fakeShadow)
  player.userData.fakeShadow = fakeShadow
  player.userData.plumes = []
  player.userData.ribbons = []
  nitroPlume = null
  headlight = null
  window.__player = player
  captureBaseline(player)

  player.position.set(0, state.y, state.z)
}

function makeFallbackCar(color, trim) {
  return makeHypercar({ body: color, accent: trim, wing: 0x111 })
}

// Rebuild player visual to match the currently-selected car (called on car
// switch). Existing player Group and fake shadow stay intact.
function rebuildPlayerCar() {
  const carId = Save.get().selectedCar
  const cfg = CAR_BY_ID[carId] ?? CAR_BY_ID[DEFAULT_CAR_ID]
  // remove the old visual body
  if (playerBody) player.remove(playerBody)
  // ── DIAG: did the GLB actually land in `assets`? ──
  console.log(`[REBUILD] selectedCar=${carId}, cfg.asset="${cfg.asset}", assets["${cfg.asset}"]=${assets[cfg.asset] ? "GLB-loaded" : "MISSING"}`)
  // Prefer the Kenney Car Kit GLB (race-future / sedan-sports / race
  // ~170KB each — proper supercar silhouettes). Fall back to the hand-
  // built procedural car only if the GLB failed to load.
  const glbCar = cloneAsset(cfg.asset, null, "z")
  const usingFallback = !glbCar
  if (usingFallback) {
    console.warn(`[REBUILD] GLB ${cfg.asset} failed to clone — falling back to makeProperCar`)
  }
  const car = glbCar
    ?? makeProperCar({ body: cfg.body ?? 0x1872ff, accent: cfg.accent ?? 0x081530 })
  // V1.8.2: yaw offset comes from the car catalogue (cars.js modelYawOffset,
  // default 0 = "use GLB natural facing"). The previous hard-coded
  // `Math.PI` was applied here AND again per-frame at updateDriving's
  // `playerBody.rotation.y = Math.PI - …`, stacking two 180° flips on top
  // of player.lookAt(). Result was a car visually pointing backwards
  // (body-forward · player-forward = −1.000 measured at runtime). Now
  // the offset is applied once here, the per-frame line uses the cached
  // value, and the GLB's actual nose direction sets the convention.
  const _yaw = cfg.modelYawOffset ?? 0
  // V1.8.3a-3: visualYawOffset is a runtime A/B knob layered ON TOP of
  // the cars.js modelYawOffset. Default Math.PI → same net rotation as
  // the pre-V1.8.2 baseline. Flip live with window.__tryFlipVisual().
  // The cars.js field stays untouched.
  const _vis = window.__tune?.visualYawOffset ?? Math.PI
  car.rotation.y = _yaw + _vis
  car.userData.modelYawOffset = _yaw
  if (cfg.body !== undefined) {
    recolorCar(car, { body: cfg.body, accent: cfg.accent })
  }
  upgradeCarMaterials(car, { clearcoat: 0.8, metalness: 0.55, roughness: 0.35 })
  sanitizePlayerCarMaterials(car)
  setupPlayerWheelRuntime(car)
  attachCarLights(car)
  attachNitroFlames(car)
  // ── DIAG: dump the player car's actual rendered geometry + materials.
  // If you see BoxGeometry / CylinderGeometry here it's the procedural
  // fallback. GLB content shows up as BufferGeometry with no parameters.
  const meshDump = []
  car.traverse((c) => {
    if (c.isMesh) {
      meshDump.push({
        name: c.name || "(unnamed)",
        geo: c.geometry?.type,
        params: c.geometry?.parameters ? Object.keys(c.geometry.parameters).join(",") : "—",
        verts: c.geometry?.attributes?.position?.count ?? 0,
        mat: c.material?.type,
        color: c.material?.color?.getHexString?.(),
        opacity: c.material?.opacity
      })
    }
  })
  console.log(`[REBUILD] playerBody using ${usingFallback ? "FALLBACK MAKEPROPERCAR" : "GLB " + cfg.asset}, mesh count=${meshDump.length}`)
  console.table(meshDump)
  player.add(car)
  playerBody = car
  playerBody.scale.setScalar(1)
  applyModelScale(player, cfg)
  window.__player = player
  window.__playerBody = playerBody
  window.__playerAudit = auditPlayerCarRuntime
  console.log("[PLAYER_AUDIT]", JSON.stringify(auditPlayerCarRuntime()))

  // apply stats to runtime CFG via the shared physics derivation
  const phys = deriveCarPhysics(cfg)
  CFG.maxSpeed = phys.maxSpeed
  CFG.nitroSpeed = phys.nitroSpeed
  CFG.carAccel = phys.accel
  CFG.carSteer = phys.steerRate
}

// Activate the level the player picked from the levels screen. The level
// drives track length, curvature, pickup density, hazards, rivals, ghost
// pacer, and time limit. Track aesthetic (sky/sunset/neon) is selected by
// level.trackStyle which still maps through the TRACKS table.
function applyLevel() {
  const levelId = Save.get().currentLevel ?? DEFAULT_LEVEL_ID
  const lvl = LEVEL_BY_ID[levelId] ?? LEVELS[0]
  state.level = lvl
  // also keep selectedTrack in sync so HUD chips / share screen work
  Save.set({ selectedTrack: lvl.trackStyle })
  applyTrack()
  CFG.trackLength = lvl.length
  CFG.finishZ = -(lvl.length - 50)
  // rivalCount in the level overrides the global default; main.js's
  // spawnRivals samples this many opponents from the OPPONENT_CARS pool
  CFG.rivalCount = lvl.rivalCount
  // pickup / ramp / hazard density via level config
  CFG.pickupGap = lvl.pickupGap ?? 26
  CFG.rampCount = lvl.rampCount ?? 0
  CFG.hazardCount = lvl.hazardCount ?? 0
  // checkpoints: either a fixed gap, or a fixed count with a spacing pattern
  CFG.checkpointGap = lvl.checkpointGap ?? 260
  CFG.checkpointCount = lvl.checkpointCount ?? null
  CFG.checkpointSpread = lvl.checkpointSpread ?? "even"
  CFG.nitroRich = !!lvl.nitroRich
  // V1.8.8-2: per-level default speed cap. Applied via the existing
  // window.__tune.speedCapMultiplier knob in updateDriving — no physics
  // or per-car stats touched. The user can still override at runtime
  // via the console; we only set the default per level on race start.
  // lv1~lv3 → 0.65, lv4~lv5 → 0.75, lv6+ → 1.0.
  const lvNum = lvl.num ?? 1
  const cap = lvNum <= 3 ? 0.65 : lvNum <= 5 ? 0.75 : 1.0
  if (typeof window !== "undefined") {
    window.__tune = window.__tune || {}
    window.__tune.speedCapMultiplier = cap
  }
}

// Apply the cosmetic backdrop (sky / sunset / neon). Called by applyLevel.
function applyTrack() {
  const lvl = state.level
  const trackId = lvl?.trackStyle ?? Save.get().selectedTrack
  const t = TRACKS[trackId] ?? TRACKS.sky
  scene.background = new THREE.Color(0x1a1430)
  scene.fog = new THREE.Fog(0x2a2638, 350, 1200)

  // Per-level sky theme override — repaints the dome and fog so each
  // level feels distinct. Falls through to TRACKS data if the level
  // isn't in LEVEL_SKY.
  const palette = LEVEL_SKY[lvl?.id]
  if (palette && skyDome) {
    const oldMap = skyDome.material.map
    skyDome.material.map = makeSkyTexture(palette.stops)
    skyDome.material.needsUpdate = true
    if (oldMap?.dispose) oldMap.dispose()
    scene.fog = new THREE.Fog(0x2a2638, 350, 1200)
    scene.background = new THREE.Color(0x1a1430)
  }

  // wet-night look for level 5: tint the fog darker + hint of teal so the
  // road's specular highlights read as water reflection.
  if (lvl?.rainShader) {
    scene.fog = new THREE.Fog(0x2a2638, 350, 1200)
    scene.background = new THREE.Color(0x1a1430)
  }

  // Rain particles only exist on lv5 — clear them otherwise so leaving
  // the wet-chase track returns to a dry race.
  setRainEnabled(!!lvl?.rainShader)
}

// Build (or tear down) the falling-rain particle system. 320 short
// streaks looping vertically near the camera, depth-limited so the
// effect doesn't try to fill the whole 2000m+ track.
function setRainEnabled(on) {
  if (on && !rainGroup) {
    rainGroup = new THREE.Group()
    const mat = new THREE.LineBasicMaterial({ color: 0xa8c8ff, transparent: true, opacity: 0.55 })
    for (let i = 0; i < 320; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, -1.4, 0)
      ])
      const drop = new THREE.Line(geo, mat)
      drop.userData.fall = 60 + Math.random() * 40
      drop.position.set(
        (Math.random() - 0.5) * 200,
        Math.random() * 60 + 8,
        (Math.random() - 0.5) * 200
      )
      rainGroup.add(drop)
    }
    scene.add(rainGroup)
  } else if (!on && rainGroup) {
    scene.remove(rainGroup)
    rainGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) o.material.dispose()
    })
    rainGroup = null
  }
}

// Animate rain (called from animateScenery in real-time so slow-mo doesn't
// freeze the storm). Drops fall at userData.fall units/sec; reset above
// the camera when they hit the ground.
function updateRain(dt) {
  if (!rainGroup) return
  const camY = camera?.position?.y ?? 4
  for (const drop of rainGroup.children) {
    drop.position.y -= drop.userData.fall * dt
    if (drop.position.y < camY - 6) {
      drop.position.y = camY + 30 + Math.random() * 20
      drop.position.x = (camera?.position?.x ?? 0) + (Math.random() - 0.5) * 200
      drop.position.z = (camera?.position?.z ?? 0) + (Math.random() - 0.5) * 200
    }
  }
}

// Koenigsegg-ish hypercar with sloped hood, bubble cabin, side scoops, big rear wing.
// Uses cell-shaded smooth surfaces instead of Kenney's blocky kit so the silhouette
// matches the screenshot's blue supercar.
// Hand-built car using primitives. Reads better than the source Kenney
// GLBs (which are intentionally low-poly cartoons) at the size we now
// render the player at. Chassis + sloped cabin + windshield + tinted
// glass + headlights + taillights + spoiler + 4 wheels. Body uses
// MeshStandardMaterial(metalness 0.7, roughness 0.3) for the lacquered-
// supercar sheen, glass uses a darker tinted physical material.
function makeProperCar(opts = {}) {
  const cfg = {
    body: 0x1872ff,
    accent: 0x081530,
    glass: 0x06121f,
    head: 0xfff0a0,
    tail: 0xff2244,
    rim: 0xc0c8d4,
    ...opts
  }
  const car = new THREE.Group()
  // ── shared materials ──────────────────────────────────────
  const bodyMat = new THREE.MeshStandardMaterial({
    color: cfg.body, metalness: 0.7, roughness: 0.3
  })
  const accentMat = new THREE.MeshStandardMaterial({
    color: cfg.accent, metalness: 0.6, roughness: 0.45
  })
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: cfg.glass, metalness: 0.3, roughness: 0.05,
    transparent: true, opacity: 0.55
  })
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.85 })
  const rimMat = new THREE.MeshStandardMaterial({ color: cfg.rim, metalness: 0.9, roughness: 0.22 })
  const headMat = new THREE.MeshStandardMaterial({ color: cfg.head, emissive: 0xfff4c8, emissiveIntensity: 1.2 })
  const tailMat = new THREE.MeshStandardMaterial({ color: cfg.tail, emissive: 0xff1a2a, emissiveIntensity: 1.0 })
  const splitMat = new THREE.MeshStandardMaterial({ color: 0x161620, roughness: 0.9 })

  // ── lower body (chassis) ──────────────────────────────────
  // Long, low, slightly wider than the cabin. Centered at z=0; nose at -2.6.
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.66, 5.2), bodyMat)
  chassis.position.set(0, 0.55, 0)
  car.add(chassis)
  // Front splitter — black bar under the nose
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.16, 0.4), splitMat)
  splitter.position.set(0, 0.18, -2.5)
  car.add(splitter)
  // Side skirts — narrow accent strips low on each side
  for (const sx of [-1.21, 1.21]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, 4.4), accentMat)
    skirt.position.set(sx, 0.32, 0)
    car.add(skirt)
  }

  // ── cabin (upper) ──────────────────────────────────────────
  // Trapezoidal cross-section: narrower at top than bottom for a sleek
  // silhouette. Achieved by rotating the front+rear faces slightly via
  // two box pieces with a slope.
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.62, 2.4), bodyMat)
  cabin.position.set(0, 1.16, -0.1)
  car.add(cabin)
  // Sloped windshield — a thin box rotated 25° to read as a raked screen.
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.84, 1.10, 0.10), glassMat)
  windshield.position.set(0, 1.18, -1.2)
  windshield.rotation.x = -0.42
  car.add(windshield)
  // Sloped rear window (less raked).
  const rearWin = new THREE.Mesh(new THREE.BoxGeometry(1.84, 0.95, 0.10), glassMat)
  rearWin.position.set(0, 1.18, 1.0)
  rearWin.rotation.x = 0.5
  car.add(rearWin)
  // Roof
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.08, 1.7), bodyMat)
  roof.position.set(0, 1.5, -0.1)
  car.add(roof)
  // Side windows (per side) — same tinted glass
  for (const sx of [-1.01, 1.01]) {
    const sw = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.45, 2.0), glassMat)
    sw.position.set(sx, 1.18, -0.1)
    car.add(sw)
  }

  // ── rear spoiler ──────────────────────────────────────────
  const spoilerStand1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, 0.12), accentMat)
  spoilerStand1.position.set(-0.85, 1.05, 2.35)
  car.add(spoilerStand1)
  const spoilerStand2 = spoilerStand1.clone()
  spoilerStand2.position.x = 0.85
  car.add(spoilerStand2)
  const spoilerWing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.10, 0.4), accentMat)
  spoilerWing.position.set(0, 1.25, 2.35)
  car.add(spoilerWing)

  // ── headlights (front, low) ───────────────────────────────
  for (const sx of [-0.78, 0.78]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.18, 0.10), headMat)
    h.position.set(sx, 0.7, -2.58)
    car.add(h)
  }

  // ── taillights (rear) ─────────────────────────────────────
  for (const sx of [-0.78, 0.78]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.18, 0.10), tailMat)
    t.position.set(sx, 0.74, 2.58)
    car.add(t)
  }
  // brake light strip across the rear
  const brake = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.06), tailMat)
  brake.position.set(0, 1.05, 2.58)
  car.add(brake)

  // ── wheels (4) ────────────────────────────────────────────
  // Cylinder geometry rotated so the axis points along X (left/right).
  const wheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.34, 18)
  for (const [wx, wz] of [[-1.12, -1.7], [1.12, -1.7], [-1.12, 1.7], [1.12, 1.7]]) {
    const tire = new THREE.Mesh(wheelGeo, tireMat)
    tire.rotation.z = Math.PI / 2
    tire.position.set(wx, 0.4, wz)
    car.add(tire)
    // Hubcap (small disk inside the tire face) — outward-facing chrome.
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.24, 0.18, 14),
      rimMat
    )
    hub.rotation.z = Math.PI / 2
    hub.position.set(wx + (wx > 0 ? 0.04 : -0.04), 0.4, wz)
    car.add(hub)
  }

  // Tag every body-panel material with a userData.origEmiH so the
  // white-flash collision effect can restore values.
  car.traverse((m) => {
    if (!m.isMesh || !m.material) return
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    for (const mat of mats) {
      if (mat.emissive) {
        mat.userData = mat.userData || {}
        mat.userData._origEmiH = mat.emissive.getHex()
        mat.userData._origEmiI = mat.emissiveIntensity ?? 0
      }
    }
  })
  // Match the Kenney-pack convention: nose points +Z. The downstream player
  // and rival update code applies rotateY(π) on top of lookAt, expecting
  // the imported model to face +Z natively. Bake that in here so the
  // procedural car drops in seamlessly.
  car.rotation.y = Math.PI
  // Bake the rotation into the geometry so future overrides of
  // playerBody.rotation.y (per-frame at line ~3820) don't undo it.
  car.updateMatrixWorld(true)
  const baked = new THREE.Group()
  car.children.slice().forEach((child) => {
    car.remove(child)
    child.applyMatrix4(car.matrix)
    baked.add(child)
  })
  return baked
}

function makeHypercar(opts = {}) {
  const colors = {
    body: 0x16a8ff,
    accent: 0x051f3a,
    wing: 0x05182f,
    glass: 0x0a1a32,
    rim: 0xd6e0ec,
    light: 0xfff4c2,
    tail: 0xff2e3a,
    ...opts
  }
  const car = new THREE.Group()
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: colors.body,
    roughness: 0.18,
    metalness: 0.65,
    clearcoat: 1,
    clearcoatRoughness: 0.06
  })
  const accentMat = new THREE.MeshStandardMaterial({ color: colors.accent, roughness: 0.4, metalness: 0.55 })
  const wingMat = new THREE.MeshStandardMaterial({ color: colors.wing, roughness: 0.32, metalness: 0.5 })
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: colors.glass,
    roughness: 0.06,
    metalness: 0.4,
    transparent: true,
    opacity: 0.78,
    transmission: 0.25
  })
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.85 })
  const rimMat = new THREE.MeshStandardMaterial({ color: colors.rim, roughness: 0.28, metalness: 0.85 })
  const headMat = new THREE.MeshStandardMaterial({ color: colors.light, emissive: 0xfff0a0, emissiveIntensity: 1.4 })
  const tailMat = new THREE.MeshStandardMaterial({ color: colors.tail, emissive: 0xff1024, emissiveIntensity: 1.2 })

  // -------- main body (lofted hull from cross-sections) --------
  const sections = [
    // {z, halfW, sideY, topY, drop}  z: car-front (-2.6) → car-rear (+2.6)
    { z: -2.6, w: 0.62, side: 0.32, top: 0.55, drop: 0.05 },
    { z: -2.0, w: 1.05, side: 0.32, top: 0.72, drop: 0.08 },
    { z: -1.0, w: 1.18, side: 0.36, top: 0.86, drop: 0.10 },
    { z: 0.0, w: 1.20, side: 0.40, top: 0.96, drop: 0.10 },
    { z: 0.9, w: 1.22, side: 0.44, top: 0.92, drop: 0.10 },
    { z: 1.8, w: 1.18, side: 0.42, top: 0.78, drop: 0.10 },
    { z: 2.6, w: 0.95, side: 0.36, top: 0.62, drop: 0.06 }
  ]
  const hull = new THREE.Mesh(loftGeometry(sections, 18), bodyMat)
  hull.position.y = 0.42
  car.add(hull)

  // -------- cabin / bubble cockpit --------
  const cabin = new THREE.Mesh(loftGeometry([
    { z: -0.7, w: 0.78, side: 1.06, top: 1.18, drop: 0.0 },
    { z: -0.1, w: 0.95, side: 1.12, top: 1.55, drop: 0.0 },
    { z: 0.5, w: 0.95, side: 1.10, top: 1.55, drop: 0.0 },
    { z: 1.15, w: 0.74, side: 1.04, top: 1.18, drop: 0.0 }
  ], 14), glassMat)
  cabin.position.y = 0.35
  car.add(cabin)

  // -------- accent stripe down the centre --------
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.06, 4.8), accentMat)
  stripe.position.set(0, 1.05, 0.05)
  car.add(stripe)

  // -------- side air-intake scoops --------
  for (const sx of [-1, 1]) {
    const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.36, 1.6), accentMat)
    scoop.position.set(sx * 1.18, 0.65, 0.4)
    scoop.rotation.y = sx * 0.05
    car.add(scoop)
  }

  // -------- rear wing --------
  const wingPost = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.55, 0.18), accentMat)
  for (const sx of [-1, 1]) {
    const post = wingPost.clone()
    post.position.set(sx * 0.9, 1.0, 2.45)
    car.add(post)
  }
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.10, 0.7), wingMat)
  wing.position.set(0, 1.32, 2.45)
  car.add(wing)
  const wingTopLip = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.04, 0.16), bodyMat)
  wingTopLip.position.set(0, 1.39, 2.65)
  car.add(wingTopLip)

  // -------- front splitter / rear diffuser --------
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 0.6), accentMat)
  splitter.position.set(0, 0.18, -2.4)
  car.add(splitter)
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.18, 0.8), accentMat)
  diffuser.position.set(0, 0.18, 2.5)
  car.add(diffuser)

  // -------- headlights / tail-lights --------
  for (const sx of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.18, 0.16), headMat)
    head.position.set(sx * 0.9, 0.78, -2.55)
    car.add(head)
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.15, 0.12), tailMat)
    tail.position.set(sx * 0.85, 0.82, 2.62)
    car.add(tail)
  }

  // -------- exhausts (twin tips) --------
  for (const sx of [-1, 1]) {
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.13, 0.4, 14), rimMat)
    exhaust.rotation.x = Math.PI / 2
    exhaust.position.set(sx * 0.55, 0.42, 2.7)
    car.add(exhaust)
  }

  // -------- wheels with rims --------
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const wheel = new THREE.Group()
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.42, 24), tireMat)
      tire.rotation.z = Math.PI / 2
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.43, 12), rimMat)
      rim.rotation.z = Math.PI / 2
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), accentMat)
      wheel.add(tire, rim, cap)
      wheel.position.set(sx * 1.13, 0.42, sz * 1.55)
      wheel.userData.spin = true
      car.add(wheel)
    }

  car.userData.wheels = car.children.filter((c) => c.userData?.spin)
  return car
}

// Cross-section loft helper (smooth car surfaces from a list of slices)
function loftGeometry(sections, cols = 16) {
  const v = []
  const idx = []
  for (const s of sections) {
    for (let c = 0; c <= cols; c++) {
      const u = (c / cols) * 2 - 1
      const crown = Math.pow(Math.max(0, 1 - Math.abs(u) ** 1.85), 0.55)
      v.push(u * s.w, s.side + (s.top - s.side) * crown - Math.abs(u) ** 1.75 * s.drop, s.z)
    }
  }
  for (let i = 0; i < sections.length - 1; i++) {
    for (let c = 0; c < cols; c++) {
      const a = i * (cols + 1) + c
      idx.push(a, a + cols + 1, a + 1, a + 1, a + cols + 1, a + cols + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

// ────────────────────────────────────────────────────────────────────
// rivals / pickups / ramps / checkpoints
// ────────────────────────────────────────────────────────────────────
function spawnRivals() {
  rivals.forEach((r) => dynamic.remove(r.car))
  rivals = []
  // level says how many rivals to spawn; 0 = no field (tutorial / time trial).
  // when missing fall back to a 3-5 random field for the legacy "free race".
  const levelCount = state.level?.rivalCount
  const fieldSize = (levelCount != null)
    ? levelCount
    : 3 + Math.floor(Math.random() * 3)
  if (fieldSize <= 0) return
  // V1.8.8-3: filter the pool by carClass for the current level so lv1~5
  // races only field formula cars (sport / utility silhouettes look out
  // of place against a formula player car). Falls back to the full
  // OPPONENT_CARS list if filtering would empty the pool — defensive,
  // shouldn't trigger with the current cars.js data.
  const lvNum = state.level?.num ?? 1
  const allowedClasses = rivalClassesForLevel(lvNum)
  let pool = OPPONENT_CARS.filter((o) => allowedClasses.includes(o.carClass))
  if (pool.length === 0) pool = [...OPPONENT_CARS]
  else pool = [...pool]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  const chosen = pool.slice(0, fieldSize)
  // Per-rival AI style from the level config (steady / aggressive / mistake)
  // — order matters and matches the rival index.
  const styles = state.level?.rivalStyles ?? []

  // 2 of them sit on the start grid alongside the player; the rest stagger
  // ahead so the player has someone to chase down the straight.
  const lanes = [-3.6, 3.6, -4.0, 4.0, -2.0, 2.0, 0]
  chosen.forEach((opp, i) => {
    const style = styles[i] ?? "steady"
    if (i < 2) {
      addRival({
        opp,
        style,
        lateral: i === 0 ? -3.6 : 3.6,
        progress: 6
      })
    } else {
      addRival({
        opp,
        style,
        lateral: lanes[i % lanes.length],
        progress: 100 + (i - 2) * 140
      })
    }
  })
}

// Style-driven AI knobs. Each rival picks one of these and the update loop
// consults them every frame:
//   steady     — consistent pace, smooth lane
//   aggressive — faster, frequent lane changes, dodges harder
//   mistake    — slower baseline, occasional speed dips + wider wobble
const RIVAL_STYLE = {
  steady:     { speedMul: 1.00, swayMul: 1.0, bobble: 0.0, mistakeFreq: 0,    aggressionMul: 1.0 },
  aggressive: { speedMul: 1.10, swayMul: 1.6, bobble: 0.0, mistakeFreq: 0,    aggressionMul: 1.7 },
  mistake:    { speedMul: 0.92, swayMul: 1.4, bobble: 0.5, mistakeFreq: 0.10, aggressionMul: 0.7 }
}

// Spawn the level-5 ghost pacer: a single car running at a fixed speed
// the player has to catch. Uses the GHOST opponent model with a very
// translucent material so it reads as "target marker, not real opponent".
function spawnGhost() {
  if (state.ghost?.car) {
    dynamic.remove(state.ghost.car)
    state.ghost = null
  }
  const cfg = state.level?.ghost
  if (!cfg) return
  const opp = OPPONENT_CARS.find((o) => o.id === "ghost") ?? OPPONENT_CARS[0]
  const car = cloneAsset(opp.asset, 4.4, "z") || makeHypercar({ body: 0xa0c8ff })
  car.rotation.y = Math.PI
  // semi-transparent cyan tint so it reads as "ghost" target
  car.traverse((m) => {
    if (!m.isMesh || !m.material) return
    const arr = Array.isArray(m.material) ? m.material : [m.material]
    for (let i = 0; i < arr.length; i++) {
      const mat = arr[i].clone()
      mat.transparent = true
      mat.opacity = 0.62
      if (mat.color) mat.color.setHex(0xa0d8ff)
      if (mat.emissive) {
        mat.emissive.setHex(0x4ab8ff)
        mat.emissiveIntensity = 0.6
      }
      arr[i] = mat
    }
    m.material = Array.isArray(m.material) ? arr : arr[0]
  })
  const startProgress = cfg.headStart ?? 80
  const pos = progressToWorld(startProgress, 0, 0.22)
  car.position.copy(pos)
  dynamic.add(car)
  state.ghost = {
    car,
    progress: startProgress,
    speed: cfg.speed ?? 160,
    catchDistance: cfg.catchDistance ?? 6
  }
  state.beatGhost = false
}

function addRival(cfg) {
  const opp = cfg.opp
  const style = cfg.style ?? "steady"
  const knobs = RIVAL_STYLE[style] ?? RIVAL_STYLE.steady
  // Rivals: Kenney no-logo pack GLBs (rival_one, crimson, shadow_zx,
  // ghost, nighthawk, etc.). 6.5m target length, recoloured per-rival.
  const car = cloneAsset(opp.asset, 6.5, "z")
    ?? makeProperCar({ body: opp.body ?? 0xe04040, accent: opp.accent ?? 0x300404 })
  car.rotation.y = Math.PI
  // V1.8.8-3: per-opponent modelScale applied on top of cloneAsset's
  // 6.5m bbox normalization. Used to pin off-spec silhouettes (trucks,
  // hatches) within ~10–15% of the formula-car visual footprint.
  const oppScale = opp.modelScale ?? 1.0
  if (oppScale !== 1.0) car.scale.multiplyScalar(oppScale)
  if (opp.body !== undefined) {
    recolorCar(car, { body: opp.body, accent: opp.accent ?? 0x300404 })
  }
  upgradeCarMaterials(car, { clearcoat: 0.55, metalness: 0.55, roughness: 0.35 })
  // place along curve at given progress
  const pos = progressToWorld(cfg.progress, cfg.lateral, 0.22)
  car.position.copy(pos)
  dynamic.add(car)
  rivals.push({
    car,
    opp,
    style,
    knobs,
    baseSpeed: Math.round(rivalBaseSpeed(opp) * knobs.speedMul),
    speedMod: 1,                       // transient slow-down used by "mistake"
    speedModUntil: 0,
    nextMistakeAt: 1500 + Math.random() * 4000,
    progress: cfg.progress,
    lateral: cfg.lateral,
    laneTarget: cfg.lateral,
    swayPhase: Math.random() * tau,
    lastHit: -9999,
    bumpVx: 0
  })
}

// Three discrete lanes the player must steer between. Coins, nitros,
// and hazards all snap to one of these so the racing surface reads as
// a 3-lane road and every pickup / obstacle requires a deliberate
// lane change.
const LANE_X = [-3.6, 0, 3.6]

function spawnPickups() {
  pickups.forEach((p) => dynamic.remove(p.mesh))
  pickups = []
  // Hand-placed layout for the polished lv1 slice — controls exact nitro
  // and cone-cluster positions. Other levels keep the procedural pattern.
  if (state.level?.heroLayout) {
    spawnHeroPickups()
    return
  }
  // Pattern: walk down the track at pickupGap steps, alternating which
  // lane the pickup sits on. This forces the player to weave between
  // -3.6 / 0 / +3.6 to chase coins instead of holding centre.
  const nitroRich = !!CFG.nitroRich
  let laneIdx = 0
  for (let s = 40; s < Track.length - 40; s += CFG.pickupGap) {
    const pattern = Math.floor(s / 100) % 4
    if (pattern === 3) continue
    const isNitroSlot = nitroRich ? pattern % 2 === 0 : pattern === 2
    const lane = LANE_X[laneIdx % LANE_X.length]
    laneIdx++
    if (isNitroSlot) {
      const m = makeNitroPickup()
      placeAlongTrack(m, s, lane, 1.9 - 0.22)
      dynamic.add(m)
      pickups.push({ mesh: m, progress: s, lateral: lane, type: "nitro", taken: false })
    } else {
      // Single coin on the chosen lane (was a 3-coin row spanning lanes,
      // which made the centre lane cover everything by accident).
      const m = makeCoin()
      placeAlongTrack(m, s, lane, 2.0 - 0.22)
      dynamic.add(m)
      pickups.push({ mesh: m, progress: s, lateral: lane, type: "coin", taken: false })
    }
  }
  // Hazards: snap to the lane that's NOT the upcoming pickup lane, so
  // staying on a coin path naturally guides into a barrier cluster the
  // player has to swerve out of.
  const hazardCount = CFG.hazardCount ?? 0
  if (hazardCount > 0) {
    const span = Track.length - 360
    for (let i = 0; i < hazardCount; i++) {
      const s = 240 + (span * i) / Math.max(1, hazardCount - 1)
      const m = makeHazard(i)
      const lane = LANE_X[(i + 1) % LANE_X.length]   // staggered vs coins
      placeAlongTrack(m, s, lane, 0.6 - 0.22)
      dynamic.add(m)
      pickups.push({ mesh: m, progress: s, lateral: lane, type: "hazard", taken: false })
    }
  }
}

// Hand-placed pickups + hazards for the lv1 vertical slice. Drives a
// readable rhythm: coin trail throughout, exactly one nitro can mid-track,
// and two cone clusters that the player has to swerve around.
function spawnHeroPickups() {
  const lvl = state.level
  const len = Track.length
  // ── coin trail: one coin per row, alternating across the 3 lanes so
  // the player has to weave between -3.6 / 0 / +3.6 to chase them.
  let laneIdx = 0
  for (let s = 40; s < len - 40; s += CFG.pickupGap) {
    const lane = LANE_X[laneIdx % LANE_X.length]
    laneIdx++
    const m = makeCoin()
    placeAlongTrack(m, s, lane, 2.0 - 0.22)
    dynamic.add(m)
    pickups.push({ mesh: m, progress: s, lateral: lane, type: "coin", taken: false })
  }
  // ── nitro pickup(s) at the level's preferred fractions ──
  for (const at of (lvl.nitroAt ?? [0.5])) {
    const s = len * at
    const m = makeNitroPickup()
    placeAlongTrack(m, s, 0, 1.9 - 0.22)
    dynamic.add(m)
    pickups.push({ mesh: m, progress: s, lateral: 0, type: "nitro", taken: false })
  }
  // ── hazards: every ~80m, cycling through a 5-lane pattern so the
  // player can't hold any single line for long. Force-swerve gameplay.
  const HAZ_PATTERN = [LANE_X[0], LANE_X[2], LANE_X[1], LANE_X[2], LANE_X[0]]
  let h = 0
  for (let s = 220; s < len - 80; s += 80) {
    const lane = HAZ_PATTERN[h % HAZ_PATTERN.length]
    h++
    const m = makeHazard(h)
    placeAlongTrack(m, s, lane, 0.6 - 0.22)
    dynamic.add(m)
    pickups.push({ mesh: m, progress: s, lateral: lane, type: "hazard", taken: false })
  }
}

function makeCoin() {
  const g = new THREE.Group()
  const coin = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.16, 12, 28), mats.gold)
  coin.rotation.x = Math.PI / 2
  g.add(coin)
  const inner = new THREE.Mesh(new THREE.CircleGeometry(0.4, 16), new THREE.MeshStandardMaterial({ color: 0xfff2a8, roughness: 0.18, metalness: 0.5 }))
  inner.rotation.x = Math.PI / 2
  g.add(inner)
  return g
}

function makeNitroPickup() {
  const g = new THREE.Group()
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.1, 14, 32), new THREE.MeshStandardMaterial({ color: 0xffe45a, emissive: 0xffd02e, emissiveIntensity: 0.5 }))
  ring.rotation.x = Math.PI / 2
  g.add(ring)
  const can = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.7, 8, 12), new THREE.MeshStandardMaterial({ color: 0xff6e2c, metalness: 0.4, roughness: 0.3 }))
  can.position.y = 0.0
  g.add(can)
  const bolt = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.6), new THREE.MeshBasicMaterial({ color: 0x16d6ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide }))
  bolt.position.set(0, 0, 0.36)
  g.add(bolt)
  return g
}

// Yellow-black warning stripe texture, generated procedurally via canvas.
// Used as the surface of the construction-barrel fallback hazard so
// obstacles read as "hazard" without needing additional GLB assets.
let _hazardStripeTex = null
function hazardStripeTexture() {
  if (_hazardStripeTex) return _hazardStripeTex
  const cv = document.createElement("canvas")
  cv.width = 128
  cv.height = 128
  const g = cv.getContext("2d")
  // dark base
  g.fillStyle = "#181820"
  g.fillRect(0, 0, 128, 128)
  // diagonal yellow stripes
  g.fillStyle = "#ffd31a"
  g.save()
  g.translate(64, 64)
  g.rotate(-Math.PI / 4)
  g.translate(-160, -160)
  for (let y = 0; y < 320; y += 28) {
    g.fillRect(0, y, 320, 14)
  }
  g.restore()
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  _hazardStripeTex = t
  return t
}

function makeHazardFallback() {
  // Construction-barrel: dark cylinder body + bright yellow-black warning
  // stripe band wrapped around the upper half. Reads as "barrier" at any
  // distance without needing to load another GLB.
  const g = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a32,
    roughness: 0.85,
    metalness: 0.18
  })
  const stripeMat = new THREE.MeshStandardMaterial({
    map: hazardStripeTexture(),
    roughness: 0.7,
    metalness: 0.1
  })
  const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.85, 0.7, 16), bodyMat)
  lower.position.y = 0.35
  g.add(lower)
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.6, 16, 1, true), stripeMat)
  stripe.position.y = 1.05
  g.add(stripe)
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 0.4, 16), bodyMat)
  upper.position.y = 1.55
  g.add(upper)
  g.userData.isFallback = true
  return tagObstacle(g, "fallback-barrel", "fallback")
}

function makeHazard(index = 0) {
  const sequence = ["cone", "barrier", "barrel"]
  const kind = sequence[index % sequence.length]
  if (kind === "cone") {
    const cone = cloneAsset("cone", 1.4, "y")
    if (cone) return tagObstacle(applyEarlyLevelContrast(cone, "cone"), "cone", "cone")
    return makeObstacleFallback("cone")
  }
  if (kind === "barrel") {
    const barrel = cloneAsset("box", 1.7, "y")
    if (barrel) return tagObstacle(applyEarlyLevelContrast(barrel, "barrier"), "barrel", "box")
    return makeObstacleFallback("barrel")
  }
  const barrier = cloneAsset(index % 2 === 0 ? "barrierRed" : "barrierWhite", 4.0)
  if (barrier) {
    barrier.rotation.y = Math.PI / 2
    return tagObstacle(applyEarlyLevelContrast(barrier, "barrier"), "barrier", index % 2 === 0 ? "barrierRed" : "barrierWhite")
  }
  return makeObstacleFallback("barrier")
}

// V1.8.8-2: high-contrast obstacle paint for lv1~lv5 only. The Kenney
// GLBs ship in muted brand colors that read fine on neon backdrops but
// disappear on the daylit lv1 sky. Repaint per kind:
//   cone      → orange + white stripe band
//   barrier   → yellow + black stripes
//   gate      → red + white stripes (checkpoint overhead)
// All other levels (6+) keep the original GLB paint.
function applyEarlyLevelContrast(obj, kind) {
  const lvNum = state.level?.num ?? 99
  if (lvNum > 5) return obj
  let primary = 0xffffff
  let stripe  = 0xffffff
  if (kind === "cone")    { primary = 0xff7a1a; stripe = 0xffffff }
  if (kind === "barrier") { primary = 0xffd31a; stripe = 0x111111 }
  if (kind === "gate")    { primary = 0xd61a2a; stripe = 0xffffff }
  obj.traverse((c) => {
    if (!c.isMesh || !c.material) return
    const mats = Array.isArray(c.material) ? c.material : [c.material]
    const repainted = mats.map((m) => {
      if (!m) return m
      const out = m.clone()
      // alternating bands: pick stripe vs primary by approximate world Y
      // position bucket so cones/barriers read with horizontal stripes.
      const yBucket = Math.floor((c.position?.y ?? 0) * 4)
      const useStripe = (yBucket & 1) === 1
      const target = useStripe ? stripe : primary
      if (out.color) out.color.setHex(target)
      if (out.emissive) {
        out.emissive.setHex(target)
        out.emissiveIntensity = 0.18
      }
      out.metalness = 0.15
      out.roughness = 0.55
      return out
    })
    c.material = Array.isArray(c.material) ? repainted : repainted[0]
  })
  return obj
}

function spawnRamps() {
  ramps.forEach((r) => dynamic.remove(r.mesh))
  ramps = []
  const want = CFG.rampCount ?? 0
  if (want <= 0) return
  // dramatic first ramp 32m ahead of start so the player sees it immediately
  const m0 = makeRamp()
  placeAlongTrack(m0, 32, 0, 0.3 - 0.22)
  dynamic.add(m0)
  ramps.push({ mesh: m0, progress: 32, lateral: 0, used: false })
  // remaining ramps spaced evenly across the rest of the track
  const rest = want - 1
  if (rest > 0) {
    const start = 240
    const span = Track.length - start - 120
    for (let i = 0; i < rest; i++) {
      const s = start + (span * (i + 1)) / (rest + 1)
      const lat = Math.sin(s * 0.02) * 2.5
      const m = makeRamp()
      placeAlongTrack(m, s, lat, 0.3 - 0.22)
      dynamic.add(m)
      ramps.push({ mesh: m, progress: s, lateral: lat, used: false })
    }
  }
}

function makeRamp() {
  const g = new THREE.Group()
  // big right-triangle wedge spanning full lane — bright yellow with chevrons
  const w = CFG.laneHalfWidth * 1.8
  const h = 2.4
  const len = 7.5
  const wedgeGeo = new THREE.BufferGeometry()
  // 8 verts: bottom rectangle 0-3, top edge at the high end 4-5
  const v = new Float32Array([
    -w / 2, 0, len / 2,   // 0 front-left bottom (low end)
    w / 2, 0, len / 2,   // 1 front-right bottom
    w / 2, 0, -len / 2,  // 2 back-right bottom
    -w / 2, 0, -len / 2,  // 3 back-left bottom
    -w / 2, h, -len / 2,  // 4 back-left top
    w / 2, h, -len / 2   // 5 back-right top
  ])
  wedgeGeo.setAttribute("position", new THREE.BufferAttribute(v, 3))
  wedgeGeo.setIndex([
    0, 1, 2, 0, 2, 3,     // base
    0, 5, 1, 0, 4, 5,     // ramp surface (slope, low front -> high back)
    3, 2, 5, 3, 5, 4,     // back vertical face
    0, 3, 4,              // left side triangle
    1, 5, 2               // right side triangle
  ])
  wedgeGeo.computeVertexNormals()
  const wedge = new THREE.Mesh(wedgeGeo, mats.ramp)
  g.add(wedge)
  // black chevron texture on the slope — apply via plane laid on the slope
  const slopeAngle = Math.atan2(h, len)
  const chevronCanvas = document.createElement("canvas")
  chevronCanvas.width = 128
  chevronCanvas.height = 256
  const cx = chevronCanvas.getContext("2d")
  cx.fillStyle = "#ffd31a"
  cx.fillRect(0, 0, 128, 256)
  cx.fillStyle = "#0f1830"
  for (let y = 0; y < 256; y += 36) {
    cx.beginPath()
    cx.moveTo(0, y)
    cx.lineTo(64, y + 26)
    cx.lineTo(128, y)
    cx.lineTo(128, y + 12)
    cx.lineTo(64, y + 38)
    cx.lineTo(0, y + 12)
    cx.closePath()
    cx.fill()
  }
  const tex = new THREE.CanvasTexture(chevronCanvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const slopeLen = Math.sqrt(len * len + h * h)
  const slope = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 0.96, slopeLen),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45 })
  )
  slope.rotation.x = -Math.PI / 2 + slopeAngle
  slope.position.set(0, h / 2, -0.0)
  g.add(slope)
  // black side panels with thin yellow rim (visual punch)
  for (const sx of [-1, 1]) {
    const sidePanelGeo = new THREE.BufferGeometry()
    const sv = new Float32Array([
      sx * w / 2, 0, len / 2,
      sx * w / 2, 0, -len / 2,
      sx * w / 2, h, -len / 2
    ])
    sidePanelGeo.setAttribute("position", new THREE.BufferAttribute(sv, 3))
    sidePanelGeo.setIndex(sx > 0 ? [0, 1, 2] : [0, 2, 1])
    sidePanelGeo.computeVertexNormals()
    const panel = new THREE.Mesh(sidePanelGeo, new THREE.MeshStandardMaterial({ color: 0x0a1a3a, roughness: 0.5 }))
    panel.position.x = sx * 0.02
    g.add(panel)
  }
  return g
}

function spawnCheckpoints() {
  checkpoints.forEach((c) => dynamic.remove(c.mesh))
  checkpoints = []
  // Two modes:
  //   1. fixed gap (level.checkpointGap > 0) — one gantry every N metres
  //   2. fixed count (level.checkpointCount) with a spread pattern:
  //      "even" = uniform spacing, "increasing" = quadratic (gaps widen)
  if (CFG.checkpointCount && CFG.checkpointCount > 0) {
    const n = CFG.checkpointCount
    const start = 180
    const end = Track.length - 80
    const span = end - start
    for (let i = 0; i < n; i++) {
      let t = (i + 1) / (n + 1)
      if (CFG.checkpointSpread === "increasing") {
        // bias later samples to the back half — gaps grow as you progress
        t = 0.25 * t + 0.75 * (t * t)
      }
      const s = start + span * t
      const m = applyEarlyLevelContrast(makeOverheadGantry(0x10c8ff, 0xfff15a, true), "gate")
      placeAlongTrack(m, s)
      dynamic.add(m)
      checkpoints.push({ mesh: m, progress: s, passed: false })
    }
  } else {
    const gap = CFG.checkpointGap ?? 260
    for (let s = 200; s < Track.length - 80; s += gap) {
      const m = applyEarlyLevelContrast(makeOverheadGantry(0x10c8ff, 0xfff15a, true), "gate")
      placeAlongTrack(m, s)
      dynamic.add(m)
      checkpoints.push({ mesh: m, progress: s, passed: false })
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// controls
// ────────────────────────────────────────────────────────────────────
function bindControls() {
  $("startGame").addEventListener("click", startRace)
  $("pauseBtn").addEventListener("click", pauseRace)
  $("resumeBtn").addEventListener("click", resumeRace)
  $("homeBtn").addEventListener("click", () => setMode("menu"))
  $("againBtn").addEventListener("click", startRace)
  $("resultHomeBtn").addEventListener("click", () => setMode("menu"))
  $("resetBtn").addEventListener("click", startRace)
  // V1.8.8: in-pause restart / return-to-levels / return-home
  if ($("pauseRestartBtn")) {
    $("pauseRestartBtn").addEventListener("click", () => {
      // resumeRace not needed — startRace flips mode to "playing"
      // and clears all run state. We DO want pauseAcc reset.
      startRace()
    })
  }
  if ($("pauseLevelsBtn")) {
    $("pauseLevelsBtn").addEventListener("click", () => {
      setMode("menu")
      openLevels()
    })
  }
  // V1.8.8: result-page navigation buttons
  if ($("resultNextBtn")) {
    $("resultNextBtn").addEventListener("click", () => {
      const lvl = state.level
      const next = lvl ? nextLevelId(lvl.id) : null
      const save = Save.get()
      if (next && save.unlockedLevels.includes(next)) {
        Save.set({ currentLevel: next })
      }
      startRace()
    })
  }
  if ($("resultLevelsBtn")) {
    $("resultLevelsBtn").addEventListener("click", () => {
      setMode("menu")
      openLevels()
    })
  }
  $("addCoins").addEventListener("click", () => {
    const v = (parseInt($("coinTotal").textContent) || 0) + 50
    $("coinTotal").textContent = String(v)
  })

  hold($("leftBtn"), () => (state.steer = -1), () => (state.steer = 0))
  hold($("rightBtn"), () => (state.steer = 1), () => (state.steer = 0))
  hold($("gasBtn"), () => (state.gas = 1), () => (state.gas = 0))
  hold($("brakeBtn"), () => (state.brake = 1), () => (state.brake = 0))
  hold($("nitroBtn"), fireNitro, () => {})

  addEventListener("keydown", (e) => {
    if (e.code === "ArrowLeft" || e.code === "KeyA") state.steer = -1
    if (e.code === "ArrowRight" || e.code === "KeyD") state.steer = 1
    if (e.code === "ArrowUp" || e.code === "KeyW") state.gas = 1
    if (e.code === "ArrowDown" || e.code === "KeyS") state.brake = 1
    if (e.code === "Space") fireNitro()
    if (e.code === "Escape") {
      if (state.mode === "playing") pauseRace()
      else if (state.mode === "paused") resumeRace()
    }
  })
  addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "KeyA", "KeyD"].includes(e.code)) state.steer = 0
    if (["ArrowUp", "KeyW"].includes(e.code)) state.gas = 0
    if (["ArrowDown", "KeyS"].includes(e.code)) state.brake = 0
  })

  bindCanvasGestures()
}

// Full-screen virtual steering pad + double-tap nitro on the canvas. The
// entire racing surface is a wheel: the X position of the user's thumb
// relative to the screen midline maps to steer direction + intensity, so
// dropping the thumb on the left half instantly turns left, right half
// turns right. Buttons + keyboard still work in parallel via state.steer.
function bindCanvasGestures() {
  const canvas = $("game")
  let active = false
  let lastTap = 0

  const computeSteer = (e) => {
    // In the rotated-shim mode (portrait + dismissed) the canvas is
    // CSS-rotated 90deg CW, so the user's left/right swipe lives along
    // the viewport's Y axis. Detect once per call so it stays correct
    // even if the user rotates mid-race.
    const rot = isRotatedPortrait()
    const span = rot ? innerHeight : innerWidth
    const pos = rot ? e.clientY : e.clientX
    const center = span / 2
    // Full deflection at ~30% away from centre — the user doesn't have to
    // drag all the way to the edge to peg the wheel, but small dead-zone
    // taps near the midline don't snap-steer.
    return clamp((pos - center) / (span * 0.3), -1, 1)
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (state.mode !== "playing") return
    active = true
    state.steer = computeSteer(e)
    // Capture so the move/up events keep flowing if the finger drifts off
    // the canvas. Wrapped in try/catch — `?.` doesn't swallow throws and
    // setPointerCapture errors on synthetic events / unsupported browsers.
    try { canvas.setPointerCapture?.(e.pointerId) } catch (_) {}
    const now = performance.now()
    if (now - lastTap < 300) fireNitro()
    lastTap = now
  })

  canvas.addEventListener("pointermove", (e) => {
    if (!active || state.mode !== "playing") return
    e.preventDefault()
    state.steer = computeSteer(e)
  })

  const release = (e) => {
    if (!active) return
    active = false
    state.steer = 0
    try { canvas.releasePointerCapture?.(e.pointerId) } catch (_) {}
  }
  canvas.addEventListener("pointerup", release)
  canvas.addEventListener("pointercancel", release)
}

function hold(el, down, up) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault()
    el.setPointerCapture?.(e.pointerId)
    down()
  })
  el.addEventListener("pointerup", (e) => {
    el.releasePointerCapture?.(e.pointerId)
    up()
  })
  el.addEventListener("pointercancel", up)
  el.addEventListener("pointerleave", up)
}

// ────────────────────────────────────────────────────────────────────
// game flow
// ────────────────────────────────────────────────────────────────────
function setMode(mode) {
  state.mode = mode
  $("menu").classList.toggle("active", mode === "menu")
  $("hud").classList.toggle("active", mode === "playing" || mode === "paused")
  $("pauseScreen").classList.toggle("active", mode === "paused")
  $("resultScreen").classList.toggle("active", mode === "result")
  // clear in-game overlays when leaving the race
  if (mode !== "playing") {
    const sl = $("speedLines")
    if (sl) sl.classList.remove("active", "nitro")
    const fx = $("screenFx")
    if (fx) fx.classList.remove("fx-impact", "fx-nitro", "fx-checkpoint")
  }
  // transition class for the screen that just became active (for fade-in)
  const active = document.querySelector(".screen.active")
  if (active) {
    active.classList.remove("fade-in")
    void active.offsetWidth
    active.classList.add("fade-in")
  }
  // music: switch loop based on mode
  setMusicMode(mode === "playing" ? "race" : "menu")
}

function showOverlay(id) {
  const el = $(id)
  if (!el) return
  el.classList.add("active", "fade-in")
}
function hideOverlay(id) {
  const el = $(id)
  if (!el) return
  el.classList.remove("active", "fade-in")
}

// ────────────────────────────────────────────────────────────────────
// settings, garage, track, daily, tutorial, share — UI wiring
// ────────────────────────────────────────────────────────────────────
function bindMetaControls() {
  // gear → settings
  $("gearBtn").addEventListener("click", openSettings)
  $("settingsCloseBtn").addEventListener("click", () => hideOverlay("settingsScreen"))
  $("setSfx").addEventListener("input", (e) => {
    Save.setSettings({ sfxVolume: +e.target.value })
    if (audio.master) audio.master.gain.value = +e.target.value
  })
  $("setMusic").addEventListener("input", (e) => {
    Save.setSettings({ musicVolume: +e.target.value })
    if (audio.musicGain) audio.musicGain.gain.value = +e.target.value
  })
  $("setQuality").addEventListener("change", (e) => {
    Save.setSettings({ quality: e.target.value })
    applyQuality()
  })
  $("setControl").addEventListener("change", (e) => {
    Save.setSettings({ controlHint: e.target.value })
  })

  // garage tile
  $("garageTile").addEventListener("click", openGarage)
  $("garageCloseBtn").addEventListener("click", () => hideOverlay("garageScreen"))
  // levels tile (formerly "tracks" — repurposed as the 5-level campaign picker)
  $("tracksTile").addEventListener("click", openLevels)
  $("trackCloseBtn").addEventListener("click", () => hideOverlay("trackScreen"))
  // missions tile (the "任务 / MISSIONS" tile) → achievements board
  $("dailyTile").addEventListener("click", openMissions)
  if ($("missionsCloseBtn")) {
    $("missionsCloseBtn").addEventListener("click", () => hideOverlay("missionsScreen"))
  }
  // daily bonus claim still wires the daily screen
  $("dailyClaimBtn").addEventListener("click", () => {
    hideOverlay("dailyScreen")
    refreshCurrencyHud()
  })
  // leaderboard close button
  if ($("leaderboardCloseBtn")) {
    $("leaderboardCloseBtn").addEventListener("click", () => hideOverlay("leaderboardScreen"))
  }
  // challenge banner close
  if ($("challengeBannerClose")) {
    $("challengeBannerClose").addEventListener("click", () => {
      $("challengeBanner").classList.remove("visible")
    })
  }
  // privacy
  $("privacyAckBtn").addEventListener("click", () => {
    Save.setSettings({ privacyAck: true })
    hideOverlay("privacyScreen")
    setTimeout(() => maybeShowDailyBonus(), 250)
  })
  // share button
  $("shareBtn").addEventListener("click", shareResult)

  // bottom action-bar nav + CTA
  const ctaBtn = document.getElementById("ctaStartRace")
  if (ctaBtn) ctaBtn.addEventListener("click", startRace)
  const navRanking = document.getElementById("navRanking")
  if (navRanking) navRanking.addEventListener("click", showLeaderboard)
  const navDaily = document.getElementById("navDaily")
  if (navDaily) navDaily.addEventListener("click", () => maybeShowDailyBonus(true))
  const navShare = document.getElementById("navShare")
  if (navShare) navShare.addEventListener("click", shareCurrentBest)
}

// Show the per-level leaderboard: each level row carries its grade + best
// time + best top-speed pulled from Save.bestPerLevel. Lives in its own
// dedicated overlay (#leaderboardScreen) instead of hijacking the result
// modal — much cleaner when the player just wants to inspect progress.
function showLeaderboard() {
  const fresh = Save.get()
  const list = $("leaderboardList")
  if (!list) return
  list.innerHTML = ""
  for (const lvl of LEVELS) {
    const best = fresh.bestPerLevel[lvl.id]
    const li = document.createElement("li")
    const gradeClass = best?.grade ? "" : "no-grade"
    li.innerHTML = `
      <span class="lb-grade ${gradeClass}">${best?.grade ?? "—"}</span>
      <span class="lb-name"><b>第 ${lvl.num} 关 · ${lvl.name}</b><span>${lvl.sub}</span></span>
      <span class="lb-time">${best ? mmss(best.ms) : "--"}</span>
      <span class="lb-speed">${best?.topSpeed ? `${best.topSpeed} KM/H` : ""}</span>
    `
    list.appendChild(li)
  }
  showOverlay("leaderboardScreen")
}

// ────────────────────────────────────────────────────────────────────
// achievements
// ────────────────────────────────────────────────────────────────────
const ACHIEVEMENTS = [
  { id: "first_race",   icon: "🏁", name: "起步",       desc: "完成你的第一场比赛",         reward: 100 },
  { id: "no_hit_clear", icon: "💎", name: "完美车技",   desc: "任意关卡零碰撞通关",         reward: 200 },
  { id: "speed_demon",  icon: "⚡", name: "速度狂魔",   desc: "最高速度突破 300 KM/H",      reward: 150 },
  { id: "coin_baron",   icon: "🪙", name: "金币大亨",   desc: "累计获得 1000 金币",         reward: 300 },
  { id: "all_S",        icon: "🏆", name: "全 S 通关", desc: "所有关卡评级都达到 S",        reward: 500 },
  { id: "collector",    icon: "🚗", name: "收藏家",     desc: "解锁所有 3 辆车",           reward: 200 }
]

// Evaluate every achievement against current state (and optionally a fresh
// run summary). Each newly-cleared one fires a toast and credits the
// reward. Idempotent — cleared ids are flagged in Save.achievements.
function checkAchievements(run = {}) {
  const sv = Save.get()
  const carCount = PLAYER_CARS.length
  const allLevelsS = LEVELS.every((l) => sv.bestPerLevel?.[l.id]?.grade === "S")
  for (const a of ACHIEVEMENTS) {
    if (sv.achievements?.[a.id]) continue
    let unlocked = false
    switch (a.id) {
      case "first_race":   unlocked = sv.totalRaces >= 1 || (run.win === true); break
      case "no_hit_clear": unlocked = run.win === true && run.hits === 0; break
      case "speed_demon":  unlocked = (run.topSpeed ?? 0) >= 300 || (sv.bestTopSpeed ?? 0) >= 300; break
      case "coin_baron":   unlocked = (sv.totalCoinsEarned ?? 0) >= 1000; break
      case "all_S":        unlocked = allLevelsS; break
      case "collector":    unlocked = (sv.unlockedCars?.length ?? 0) >= carCount; break
    }
    if (unlocked && Save.markAchievement(a.id)) {
      Save.addCoins(a.reward)
      toast(`${a.icon} ${a.name} +${a.reward}`, 1600)
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// first-play tutorial hints
// ────────────────────────────────────────────────────────────────────
let _tutorialHideTimer = null
// Show a tutorial hint overlay once per save (keyed by `key`). Auto-fades
// after `duration` ms. The overlay lives at index.html / styles.css —
// this helper just toggles `.visible` and swaps text.
function showTutorialHint(key, text, duration = 2200) {
  if (Save.hasSeenTutorial(key)) return
  const el = $("tutorialHint")
  const txt = $("tutorialHintText")
  if (!el || !txt) return
  txt.textContent = text
  el.classList.add("visible")
  Save.markTutorialSeen(key)
  clearTimeout(_tutorialHideTimer)
  _tutorialHideTimer = setTimeout(() => el.classList.remove("visible"), duration)
}

// Coarse phone vs desktop split — drives the wording of the steering
// hint (arrows on PC, swipe on phone).
function isTouchDevice() {
  return ("ontouchstart" in window) || (navigator.maxTouchPoints > 0)
}

// First-play race intro: shown on the first launch of lv1. Three staged
// hints at start / first coin / first nitro pickup.
function maybeShowRaceIntroHints() {
  const lvl = state.level
  if (!lvl || lvl.id !== "lv1") return
  if (Save.hasSeenTutorial("intro_steer")) return
  // Steering hint 600ms after countdown shows so the player can read it
  // before the green light hits.
  setTimeout(() => {
    showTutorialHint(
      "intro_steer",
      isTouchDevice() ? "左右滑动转向，避开障碍" : "← → 左右转向避开障碍",
      3000
    )
  }, 600)
}

function openMissions() {
  // Refresh — accomplishments may have unlocked between visits
  checkAchievements()
  const sv = Save.get()
  const list = $("missionsList")
  if (!list) return
  list.innerHTML = ""
  for (const a of ACHIEVEMENTS) {
    const done = !!sv.achievements?.[a.id]
    const li = document.createElement("li")
    if (done) li.classList.add("done")
    li.innerHTML = `
      <div class="ach-icon">${a.icon}</div>
      <div class="ach-meta"><b>${a.name}</b><span>${a.desc}</span></div>
      <div class="ach-status">${done ? "已完成" : `+${a.reward} 🪙`}</div>
    `
    list.appendChild(li)
  }
  showOverlay("missionsScreen")
}

// Share current local best stats as PNG
function shareCurrentBest() {
  const fresh = Save.get()
  const best = fresh.bestTimePerTrack[fresh.selectedTrack]
  if (!best) {
    toast("还没成绩，先比一局！", 1100)
    return
  }
  $("resultTitle").textContent = "我的最佳"
  $("resStatTime").textContent = mmss(best.ms)
  $("resStatCoins").textContent = String(fresh.coins)
  $("resStatHits").textContent = String(fresh.totalRaces)
  shareResult()
}

function openSettings() {
  const s = Save.get().settings
  $("setSfx").value = s.sfxVolume
  $("setMusic").value = s.musicVolume
  $("setQuality").value = s.quality
  $("setControl").value = s.controlHint
  showOverlay("settingsScreen")
}

function openGarage() {
  const list = $("garageList")
  list.innerHTML = ""
  const save = Save.get()
  PLAYER_CARS.forEach((c) => {
    const unlocked = save.unlockedCars.includes(c.id)
    const selected = save.selectedCar === c.id
    const card = document.createElement("div")
    card.className = `garage-card ${unlocked ? "" : "locked"} ${selected ? "selected" : ""}`
    const bodyHex = (c.body ?? 0x6a7280).toString(16).padStart(6, "0")
    const accentHex = (c.accent ?? 0x101820).toString(16).padStart(6, "0")
    const previewBg = `linear-gradient(135deg, #${bodyHex}, #${accentHex})`
    const tier = TIER_STYLE[c.tier] ?? TIER_STYLE.C
    // Stat bars use a 0-100% scale tuned for the current top-tier values
    // (Shadow ZX: 312/3.0/9.4/9.1) so S-tier reads near-full.
    const speedPct = clamp((c.topSpeed - 200) / 130 * 100, 0, 100)
    const accelPct = clamp((5.0 - c.accel0to100) / 2.2 * 100, 0, 100)
    const handlePct = clamp((c.handling - 7) / 2.6 * 100, 0, 100)
    const nitroPct = clamp((c.nitro - 5) / 4.5 * 100, 0, 100)
    card.innerHTML = `
      <div class="preview" style="background:${previewBg}">
        <span class="tier-chip" style="background:${tier.bg};color:${tier.fg}">${c.tier}</span>
      </div>
      <b>${c.name}</b>
      <div class="stats">
        <div class="stat-bar"><b>极速</b><i style="--gap:${100 - speedPct}%"></i><u>${c.topSpeed}</u></div>
        <div class="stat-bar"><b>加速</b><i style="--gap:${100 - accelPct}%"></i><u>${c.accel0to100}s</u></div>
        <div class="stat-bar"><b>操控</b><i style="--gap:${100 - handlePct}%"></i><u>${c.handling}</u></div>
        <div class="stat-bar"><b>氮气</b><i style="--gap:${100 - nitroPct}%"></i><u>${c.nitro}</u></div>
      </div>
      ${unlocked ? (selected ? `<small class="badge-owned">已选定</small>` : `<small class="badge-owned">已拥有</small>`) : `<small class="badge-lock">🔒 ${c.price.toLocaleString()} 金币</small>`}
    `
    card.addEventListener("click", () => {
      if (unlocked) {
        Save.set({ selectedCar: c.id })
        rebuildPlayerCar()
        openGarage()
      } else {
        const cur = Save.get()
        if (cur.coins >= c.price) {
          Save.addCoins(-c.price)
          Save.unlockCar(c.id)
          Save.set({ selectedCar: c.id })
          rebuildPlayerCar()
          refreshCurrencyHud()
          openGarage()
        } else {
          toast(`金币不足 (${cur.coins}/${c.price})`, 1200)
        }
      }
    })
    list.appendChild(card)
  })
  showOverlay("garageScreen")
}

// 5-level campaign picker (replaces the old free-track picker). Cards show
// number, name, sub-tagline, lock state, and best grade so far.
function openLevels() {
  const list = $("trackList")
  list.innerHTML = ""
  const save = Save.get()
  LEVELS.forEach((lvl) => {
    const unlocked = save.unlockedLevels.includes(lvl.id)
    const selected = save.currentLevel === lvl.id
    const best = save.bestPerLevel[lvl.id]
    const card = document.createElement("div")
    card.className = `level-card ${unlocked ? "" : "locked"} ${selected ? "selected" : ""}`
    // map each level to a backdrop gradient using its trackStyle
    const tCfg = TRACKS[lvl.trackStyle] ?? TRACKS.sky
    const previewBg = `linear-gradient(180deg, #${tCfg.sky.toString(16).padStart(6, "0")}, #${tCfg.fog[0].toString(16).padStart(6, "0")})`
    const gradeChip = best?.grade
      ? `<span class="lvl-grade g-${best.grade}">${best.grade}</span>`
      : ""
    card.innerHTML = `
      <div class="preview" style="background:${previewBg}">
        <span class="lvl-num">第 ${lvl.num} 关</span>
        ${gradeChip}
      </div>
      <b>${lvl.name}</b>
      <em class="lvl-sub">${lvl.sub}</em>
      <small class="lvl-desc">${lvl.desc}</small>
      ${best ? `<small class="lvl-best">最佳: ${mmss(best.ms)} · ${best.coins} 金币</small>` : ""}
      ${unlocked ? "" : `<small class="lvl-lock">🔒 通关上一关解锁</small>`}
    `
    card.addEventListener("click", () => {
      if (!unlocked) {
        toast(`先通关第 ${lvl.num - 1} 关`, 1200)
        return
      }
      Save.set({ currentLevel: lvl.id })
      openLevels()
    })
    list.appendChild(card)
  })
  showOverlay("trackScreen")
}

function maybeShowDailyBonus(force = false) {
  // first show privacy ack on first run
  if (!Save.get().settings.privacyAck) {
    showOverlay("privacyScreen")
    return
  }
  if (force) {
    // force claim
    const r = Save.claimDaily()
    if (r.granted) {
      $("dailyDay").textContent = r.day
      $("dailyAmount").textContent = `+${r.amount}`
      showOverlay("dailyScreen")
    } else {
      toast("今天已领取", 900)
    }
    refreshCurrencyHud()
    return
  }
  const today = new Date().toISOString().slice(0, 10)
  if (Save.get().lastDaily === today) {
    refreshCurrencyHud()
    return
  }
  const r = Save.claimDaily()
  if (r.granted) {
    $("dailyDay").textContent = r.day
    $("dailyAmount").textContent = `+${r.amount}`
    showOverlay("dailyScreen")
  }
  refreshCurrencyHud()
}

function refreshCurrencyHud() {
  const s = Save.get()
  if ($("coinTotal")) $("coinTotal").textContent = String(s.coins)
  if ($("cashTotal")) $("cashTotal").textContent = String(s.gems)
}

// Apply quality settings (pixelRatio + shadowMap)
function applyQuality() {
  const q = Save.get().settings.quality
  const dpr = q === "low" ? 1 : q === "medium" ? 1.5 : q === "high" ? 2 : Math.min(window.devicePixelRatio || 1, 2)
  if (renderer) {
    renderer.setPixelRatio(dpr)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
  }
}

function ensureAuditOverlay() {
  if (!import.meta.env.DEV) return null
  if (auditOverlay) return auditOverlay
  auditOverlay = document.createElement("div")
  auditOverlay.id = "audit-overlay"
  auditOverlay.textContent = "audit pending"
  document.body.appendChild(auditOverlay)
  return auditOverlay
}

function updateAuditGuard() {
  auditFrame++
  if (auditFrame % 60 !== 0) return
  const issues = runAudit(window.__player, scene, camera)
  let meshCount = 0
  window.__player?.traverse((c) => { if (c.isMesh) meshCount++ })
  let fallbackCount = 0
  const obstacleSamples = []
  const obstacleSampleKeys = new Set()
  scene.traverse((c) => {
    if (c.userData?.isFallback) fallbackCount++
    if (c.userData?.isObstacle && obstacleSamples.length < 12) {
      const key = `${c.userData.obstacleKind}:${c.userData.obstacleAsset}:${c.type}:${c.geometry?.type ?? "group"}`
      if (obstacleSampleKeys.has(key)) return
      obstacleSampleKeys.add(key)
      obstacleSamples.push({
        type: c.type,
        geometry: c.geometry?.type ?? null,
        kind: c.userData.obstacleKind,
        asset: c.userData.obstacleAsset,
        isFallback: !!c.userData.isFallback
      })
    }
  })
  const data = {
    playerScaleX: window.__player?.scale?.x,
    cameraDistance: camera.position.distanceTo(window.__player.position),
    playerMeshCount: meshCount,
    auditIssues: issues,
    obstacleSamples,
    fallbackCount
  }
  window.__lastAuditData = data
  console.log("[AUDIT_DATA]", JSON.stringify(data))
  if (import.meta.env.DEV) {
    const overlay = ensureAuditOverlay()
    if (overlay) {
      overlay.textContent = issues.length === 0 ? "✅ audit clean" : issues.join(" | ")
      overlay.classList.toggle("bad", issues.length > 0)
    }
  } else if (issues.length > 0) {
    console.warn("[audit]", issues)
  }
}

// First-time tutorial overlay — shown on the very first race only
function maybeShowTutorial() {
  if (Save.get().hasOnboarded) return
  $("tutorialOverlay").classList.add("show")
  setTimeout(() => {
    $("tutorialOverlay").classList.remove("show")
    Save.set({ hasOnboarded: true })
  }, 5000)
}

// Generate a result-screenshot PNG and offer it to the user
// Build a challenge URL that re-renders this run's headline on the
// recipient's home page banner. Format: ?challenge=<lvId>_<sec>s_<grade>
// e.g. ?challenge=lv1_38s_S — small enough to paste, parseable
// without a server.
function buildChallengeUrl(lvlId, ms, grade) {
  const sec = Math.round(ms / 1000)
  const url = new URL(location.href)
  url.searchParams.set("challenge", `${lvlId}_${sec}s_${grade ?? "C"}`)
  return url.toString()
}

// Generate the result card as a 720×960 PNG and either trigger a download
// or hand it to the OS share sheet via navigator.share / clipboard.
async function shareResult() {
  try {
    const sv = Save.get()
    const lvl = state.level
    const grade = state._lastGrade ?? "?"
    const c = document.createElement("canvas")
    c.width = 720
    c.height = 960
    const g = c.getContext("2d")
    // backdrop — deep navy → indigo → magenta sweep, picks up the cyberpunk vibe
    const bg = g.createLinearGradient(0, 0, 0, 960)
    bg.addColorStop(0, "#070b1c")
    bg.addColorStop(0.55, "#181a4a")
    bg.addColorStop(1, "#3d0f56")
    g.fillStyle = bg
    g.fillRect(0, 0, 720, 960)
    // gold border frame
    g.strokeStyle = "#ffd31a"
    g.lineWidth = 4
    g.strokeRect(20, 20, 680, 920)
    // header
    g.fillStyle = "#ffd31a"
    g.font = "bold 56px sans-serif"
    g.textAlign = "center"
    g.fillText("⚡ 闪电飞车", 360, 110)
    g.fillStyle = "#93a8c8"
    g.font = "bold 18px sans-serif"
    g.fillText("LIGHTNING RACER", 360, 138)
    // level name + sub
    if (lvl) {
      g.fillStyle = "#fff"
      g.font = "bold 32px sans-serif"
      g.fillText(`第 ${lvl.num} 关 · ${lvl.name}`, 360, 198)
      g.fillStyle = "#93a8c8"
      g.font = "16px sans-serif"
      g.fillText(lvl.sub, 360, 224)
    }
    // big grade letter
    g.fillStyle = grade === "S" ? "#ffd31a" : grade === "A" ? "#26d6ff" : "#cfe0ff"
    g.font = "bold 220px sans-serif"
    g.fillText(grade, 360, 460)
    // stats grid
    g.font = "bold 30px sans-serif"
    g.fillStyle = "#fff"
    g.textAlign = "left"
    const stats = [
      ["用时", $("resStatTime").textContent],
      ["金币", $("resStatCoins").textContent],
      ["最高速度", `${($("resStatTopSpeed")?.textContent ?? Math.round(state.topSpeed))} KM/H`],
      ["碰撞", $("resStatHits").textContent],
      ["排名", `第 ${state._finalRank ?? 1} 名`]
    ]
    let row = 540
    for (const [label, value] of stats) {
      g.fillStyle = "#93a8c8"
      g.font = "20px sans-serif"
      g.fillText(label, 90, row)
      g.fillStyle = "#ffe35a"
      g.font = "bold 32px sans-serif"
      g.textAlign = "right"
      g.fillText(value, 630, row)
      g.textAlign = "left"
      row += 56
    }
    // footer
    g.fillStyle = "#93a8c8"
    g.font = "16px sans-serif"
    g.textAlign = "center"
    g.fillText("shandian.railmountgame.com", 360, 880)
    if (lvl) {
      const ms = state.finishedAt - state.startedAt - state.pauseAcc
      const challenge = buildChallengeUrl(lvl.id, ms, grade)
      g.fillStyle = "#ffd31a"
      g.font = "14px sans-serif"
      g.fillText("挑战链接: " + (challenge.length > 56 ? challenge.slice(0, 56) + "…" : challenge), 360, 910)
    }
    // Output: try Web Share with file → clipboard URL → download fallback.
    c.toBlob(async (blob) => {
      if (!blob) { toast("生成失败", 900); return }
      const file = new File([blob], `shandian-feiche-${Date.now()}.png`, { type: "image/png" })
      const challenge = lvl ? buildChallengeUrl(lvl.id, state.finishedAt - state.startedAt - state.pauseAcc, grade) : location.href
      try {
        if (navigator.share && navigator.canShare?.({ files: [file] })) {
          await navigator.share({
            title: "闪电飞车战绩",
            text: lvl ? `${lvl.name} ${grade} 级，挑战我！` : "闪电飞车战绩",
            url: challenge,
            files: [file]
          })
          toast("已分享", 1200)
          return
        }
      } catch (_) { /* user cancelled or unsupported — fall through */ }
      // Download fallback: card as PNG + copy challenge URL to clipboard.
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = file.name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
      try { await navigator.clipboard?.writeText(challenge) } catch (_) {}
      toast("战绩卡已下载，挑战链接已复制", 1500)
    }, "image/png")
  } catch (e) {
    toast("分享生成失败", 900)
  }
}

// Unlock audio on first user gesture (browsers require this).
function bindAudioUnlock() {
  const handler = () => {
    unlockAudio()
    removeEventListener("pointerdown", handler)
    removeEventListener("keydown", handler)
  }
  addEventListener("pointerdown", handler, { once: false })
  addEventListener("keydown", handler, { once: false })
}

function startRace() {
  // apply currently-selected car + level BEFORE resetting world. applyLevel
  // sets state.level, plugs the level's curve/length/density into CFG and
  // updates the cosmetic backdrop. All subsequent build/spawn calls then
  // read those CFG values, so this is the single switch that "loads" a level.
  rebuildPlayerCar()
  applyLevel()
  buildTrack()
  buildScenery()
  spawnPickups()
  spawnRamps()
  spawnCheckpoints()
  spawnRivals()
  spawnGhost()

  // reset run state
  state.speed = 0
  state.lateral = 0
  state.progress = 0       // start at the very beginning of the curve
  state.y = 0.22
  state.vy = 0
  state.steer = 0
  state.gas = 0      // locked during countdown
  state.brake = 0
  state.nitroCharges = 1
  state.nitroTime = 0
  state.coins = 0
  state.hits = 0
  state.shake = 0
  state.countdown = 3 // 3..2..1..0 (0 = GO)
  state.startedAt = performance.now() + 3200
  state.pauseAcc = 0
  state.finished = false
  state.finishedAt = 0
  state.lastRivalHit = 0
  state.airborne = false
  state.topSpeed = 0   // tracked through the race for the result modal
  state._finalRank = null   // frozen at finishRace() time
  state.beatGhost = false
  state.timedOut = false
  state._lastRank = null      // for overtake toasts
  state._lastOvertakeAt = 0

  // reset world (rivals already placed correctly by spawnRivals above)
  pickups.forEach((p) => {
    p.taken = false
    p.mesh.visible = true
  })
  ramps.forEach((r) => (r.used = false))
  checkpoints.forEach((c) => (c.passed = false))

  // place player on the curve at progress=0
  const startPos = progressToWorld(0, 0, state.y)
  player.position.copy(startPos)
  player.rotation.set(0, 0, 0)
  setMode("playing")
  runCountdown()
  maybeShowTutorial()
  maybeShowRaceIntroHints()
}

// 3-2-1-GO! sequence: red lights tick down, green flashes, controls unlock.
function runCountdown() {
  const overlay = $("countdownOverlay")
  const num = $("countdownNum")
  const lights = overlay.querySelectorAll(".cd-light")
  overlay.classList.add("show")
  lights.forEach((l) => l.classList.remove("lit", "go"))
  num.classList.remove("go")

  let step = 3
  const tick = () => {
    if (step > 0) {
      num.textContent = String(step)
      num.classList.remove("go")
      // re-trigger pop animation
      num.style.animation = "none"
      void num.offsetWidth
      num.style.animation = ""
      // light up the right number of red lights (4-step → 3,2,1)
      lights.forEach((l, i) => {
        l.classList.toggle("lit", i < (4 - step))
      })
      // engine rev sound on each tick
      if (audio.ctx) {
        const o = audio.ctx.createOscillator()
        const g = audio.ctx.createGain()
        o.type = "sawtooth"
        o.frequency.setValueAtTime(180, audio.ctx.currentTime)
        o.frequency.exponentialRampToValueAtTime(90, audio.ctx.currentTime + 0.3)
        g.gain.setValueAtTime(0.18, audio.ctx.currentTime)
        g.gain.exponentialRampToValueAtTime(0.001, audio.ctx.currentTime + 0.32)
        o.connect(g); g.connect(audio.master)
        o.start()
        o.stop(audio.ctx.currentTime + 0.35)
      }
      // small camera nudge per beep — sells the build-up
      state.shake = Math.max(state.shake, 0.12)
      step--
      state.countdown = step + 1
      setTimeout(tick, 900)
    } else {
      // GO! — full countdown payoff: flash, shake, pitch-up sweep, nitro burst
      num.textContent = "GO!"
      num.classList.add("go")
      lights.forEach((l) => l.classList.add("go"))
      state.countdown = 0
      state.gas = 1
      state.shake = 0.55              // bigger kick than before
      flashFx("nitro")                // green-white screen pop
      // GO sound: short pitch-up sweep + sub-bass thud
      if (audio.ctx) {
        const ctx = audio.ctx
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.type = "sawtooth"
        o.frequency.setValueAtTime(200, ctx.currentTime)
        o.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.32)
        g.gain.setValueAtTime(0.34, ctx.currentTime)
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)
        o.connect(g); g.connect(audio.master)
        o.start()
        o.stop(ctx.currentTime + 0.55)
        // sub-bass thud
        const sub = ctx.createOscillator()
        const sg = ctx.createGain()
        sub.type = "sine"
        sub.frequency.setValueAtTime(80, ctx.currentTime)
        sub.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.3)
        sg.gain.setValueAtTime(0.45, ctx.currentTime)
        sg.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.32)
        sub.connect(sg); sg.connect(audio.master)
        sub.start()
        sub.stop(ctx.currentTime + 0.34)
      }
      setTimeout(() => overlay.classList.remove("show"), 600)
    }
  }
  tick()
}

function pauseRace() {
  if (state.mode !== "playing") return
  state.pauseAt = performance.now()
  // V1.8.8: zero out held inputs so a paused car is fully frozen — the
  // loop already skips updateDriving in non-playing modes, but if the
  // user pauses with gas held the value lingers in state.* and would
  // pop on resume. Wind/engine SFX are gated on state.mode==="playing"
  // by setEngineLoad / setSpeedFx.
  state.steer = 0
  state.gas = 0
  state.brake = 0
  setMode("paused")
}
function resumeRace() {
  if (state.mode !== "paused") return
  state.pauseAcc += performance.now() - state.pauseAt
  setMode("playing")
}
function fireNitro() {
  if (state.mode !== "playing" || state.nitroCharges <= 0 || state.nitroTime > 0) return
  state.nitroCharges--
  // Lv4 (氮气挑战) extends nitro by 60% — fits the level fantasy of
  // dragging long boost windows between checkpoints.
  const dur = CFG.nitroDuration * (state.level?.id === "lv4" ? 1.6 : 1)
  state.nitroTime = dur
  state.shake = 0.4
  const t = performance.now()
  state.nitroSaturateUntil = t + dur * 1000
  // V1.7.1 nitro burst: 200ms FOV spike to 92, then 400ms decay back as
  // updateCamera lerps toward the normal target. nitroFovSpikeUntil is
  // a hard window — while inside it, updateCamera force-targets 92 and
  // ignores the speed/accel/portrait offset bands.
  state.nitroFovSpikeUntil = t + 200
  toast("NITRO!", 900)
  sfxNitro()
  flashWhite()       // hard white flash on activation
  flashFx("nitro")   // cyan halo follows
}

function finishRace(success = true) {
  if (state.finished) return
  state.finished = true
  state.finishedAt = performance.now()
  state._finalRank = computeRank()
  if (success) sfxCheckpoint()
  setTimeout(() => {
    const ms = state.finishedAt - state.startedAt - state.pauseAcc
    const win = success && state.hits < CFG.hitLimit && !state.timedOut
    const save = Save.get()
    const lvl = state.level
    Save.recordRace({
      trackId: save.selectedTrack,
      carId: save.selectedCar,
      ms,
      coins: state.coins,
      hits: state.hits,
      success: win,
      topSpeed: state.topSpeed
    })
    // ── grade for the level (S/A/B/C) ──
    let grade = null
    let unlocked = null
    let gradeBonus = 0
    if (lvl) {
      grade = gradeForRun(lvl, {
        ms,
        coins: state.coins,
        hits: state.hits,
        finished: win,
        beatGhost: state.beatGhost
      })
      Save.recordLevelResult(lvl.id, {
        grade,
        ms,
        coins: state.coins,
        topSpeed: Math.round(state.topSpeed),
        beatGhost: state.beatGhost
      })
      // success → unlock the next level (if there is one) + award a grade bonus.
      if (win) {
        const next = nextLevelId(lvl.id)
        if (next && !Save.get().unlockedLevels.includes(next)) {
          Save.unlockLevel(next)
          unlocked = next
        }
        // Per spec: S = +50% of run coins on top of the flat bonus,
        // A = +25%. B/C just get the small flat amount. Plus a flat
        // perfect-bonus +50 if the run ended with zero hits.
        const flat = grade === "S" ? 40
                  : grade === "A" ? 25
                  : grade === "B" ? 15
                  : 5
        const pct = grade === "S" ? 0.5 : grade === "A" ? 0.25 : 0
        const perfect = state.hits === 0 ? 50 : 0
        gradeBonus = flat + Math.floor(state.coins * pct) + perfect
        Save.addCoins(gradeBonus)
        // Side-effect: lifetime coin total used by the "coin baron" achievement
        const sv = Save.get()
        sv.totalCoinsEarned = (sv.totalCoinsEarned || 0) + gradeBonus
        Save.set({ totalCoinsEarned: sv.totalCoinsEarned })
      }
      // Check + claim any newly-unlocked achievements based on this run.
      checkAchievements({ win, hits: state.hits, topSpeed: state.topSpeed, grade })
    }
    // determine "new record" BEFORE the new ms is recorded
    const prevBest = save.bestTimePerTrack[save.selectedTrack]
    const isNewRecord = win && (!prevBest || ms < prevBest.ms)
    $("resStatTime").textContent = mmss(ms)
    $("resStatCoins").textContent = String(state.coins)
    if ($("resStatTopSpeed")) $("resStatTopSpeed").textContent = `${Math.round(state.topSpeed)}`
    $("resStatHits").textContent = String(state.hits)
    // title + copy reflect the level pass/fail reason
    if (lvl) {
      if (state.timedOut) {
        $("resultTitle").textContent = "时间到 · 挑战失败"
        $("resultCopy").textContent = `第 ${lvl.num} 关「${lvl.name}」未在 ${lvl.timeLimit}s 内完成`
      } else if (win) {
        $("resultTitle").textContent = `第 ${lvl.num} 关 · ${lvl.name}`
        const ghostMsg = lvl.ghost
          ? (state.beatGhost ? "追上目标车！" : "未追上目标车")
          : ""
        $("resultCopy").textContent = `${mmss(ms)} 冲线，最高 ${Math.round(state.topSpeed)} KM/H${ghostMsg ? "，" + ghostMsg : ""}`
      } else {
        $("resultTitle").textContent = `第 ${lvl.num} 关 · 失败`
        $("resultCopy").textContent = `碰撞太多 (${state.hits}/${CFG.hitLimit})，再来一局！`
      }
    } else {
      $("resultTitle").textContent = win ? "闯关成功！" : "再试一次"
      $("resultCopy").textContent = win
        ? `用 ${mmss(ms)} 冲过终点，最高速度 ${Math.round(state.topSpeed)} KM/H。`
        : `碰撞太多 (${state.hits}/${CFG.hitLimit})，再来一局！`
    }
    if ($("resNewRecord")) $("resNewRecord").style.display = isNewRecord ? "block" : "none"
    // reward line: in-race coins + grade bonus, totalling what was just added
    const rewardEl = $("resReward")
    if (rewardEl) {
      const totalReward = state.coins + gradeBonus
      if (win && totalReward > 0) {
        rewardEl.innerHTML = `🪙 奖励 +<b>${totalReward}</b> 金币` +
          (gradeBonus > 0 ? ` <span class="reward-bonus">(基础 ${state.coins} + ${grade ?? ""} 评分 ${gradeBonus})</span>` : "")
        rewardEl.style.display = ""
      } else {
        rewardEl.style.display = "none"
      }
    }
    // grade badge (S / A / B / C / fail)
    state._lastGrade = grade ?? "C"
    const gradeEl = $("resGrade")
    if (gradeEl) {
      gradeEl.classList.remove("g-S", "g-A", "g-B", "g-C", "g-fail")
      if (grade) {
        gradeEl.classList.add(`g-${grade}`)
        gradeEl.textContent = grade
        gradeEl.style.display = ""
      } else {
        gradeEl.classList.add("g-fail")
        gradeEl.textContent = "—"
        gradeEl.style.display = ""
      }
    }
    // unlock-next banner
    const unlockEl = $("resUnlock")
    if (unlockEl) {
      if (unlocked && LEVEL_BY_ID[unlocked]) {
        const u = LEVEL_BY_ID[unlocked]
        unlockEl.textContent = `🔓 解锁了第 ${u.num} 关「${u.name}」`
        unlockEl.style.display = ""
      } else {
        unlockEl.style.display = "none"
      }
    }
    // V1.8.8: "下一关" button only shown when there's an unlocked next
    // level the player can jump to. Drives off Save state so a level
    // already unlocked from a previous run still shows the button.
    const nextBtn = $("resultNextBtn")
    if (nextBtn) {
      const nextId = lvl ? nextLevelId(lvl.id) : null
      const canGoNext = nextId && Save.get().unlockedLevels.includes(nextId)
      nextBtn.style.display = canGoNext ? "" : "none"
    }
    // V1.8.3a-4: explain WHY the next level did or didn't unlock.
    // Always-visible checklist with ✓/✗ rows so the player can self-
    // diagnose. Doesn't change unlock logic — this is read-only.
    const detailEl = $("resUnlockDetail")
    if (detailEl && lvl) {
      const nextId = nextLevelId(lvl.id)
      const nextLvl = nextId ? LEVEL_BY_ID[nextId] : null
      const alreadyUnlockedNext = nextId && Save.get().unlockedLevels.includes(nextId)
      // Build the criteria list. Order: must finish, then optional
      // gates that vary by level (collision limit, time limit, ghost).
      const rows = []
      // 1. Reach the finish line
      const reachedFinish = success && !state.timedOut
      rows.push({
        ok: reachedFinish,
        label: "冲过终点线",
        actual: reachedFinish ? "✓ 已完成" : (state.timedOut ? "✗ 时间到" : "✗ 未冲线")
      })
      // 2. Hits below the limit
      const hitsOk = state.hits < CFG.hitLimit
      rows.push({
        ok: hitsOk,
        label: `碰撞 ＜ ${CFG.hitLimit} 次`,
        actual: `${hitsOk ? "✓" : "✗"} 本次 ${state.hits} 次`
      })
      // 3. Time limit (if level has one)
      if (lvl.timeLimit && lvl.timeLimit > 0) {
        const sec = ms / 1000
        const timeOk = sec <= lvl.timeLimit
        rows.push({
          ok: timeOk,
          label: `${lvl.timeLimit} 秒内完成`,
          actual: `${timeOk ? "✓" : "✗"} 本次 ${sec.toFixed(1)}s`
        })
      }
      // 4. Ghost (if level has one — for grade S, but shown as criteria)
      if (lvl.ghost) {
        rows.push({
          ok: state.beatGhost,
          label: "追上目标车",
          actual: state.beatGhost ? "✓ 已追上" : "✗ 未追上"
        })
      }
      // Title text depends on outcome:
      let title
      if (!nextId) {
        title = "🏁 已经是最后一关 — 没有可解锁的下一关"
      } else if (alreadyUnlockedNext && !unlocked) {
        title = `📋 第 ${nextLvl.num} 关「${nextLvl.name}」此前已解锁`
      } else if (unlocked) {
        title = `📋 解锁第 ${nextLvl.num} 关「${nextLvl.name}」的条件（全部满足）`
      } else {
        title = `📋 解锁下一关需要满足以下全部条件：`
      }
      const rowsHtml = rows.map((r) => `
        <div class="ud-row ${r.ok ? "ok" : "fail"}">
          <span>${r.label}</span><b>${r.actual}</b>
        </div>
      `).join("")
      // Extra hint when this run failed and there's still hope:
      let hintHtml = ""
      if (!win && nextId) {
        hintHtml = `<div style="margin-top:6px;color:#93a8c8;font-size:calc(var(--ui)*0.88)">
          点「再玩一局」继续挑战，把每一项 ✗ 变成 ✓ 就能解锁第 ${nextLvl.num} 关。
        </div>`
      }
      detailEl.innerHTML = `<span class="ud-title">${title}</span>${rowsHtml}${hintHtml}`
      detailEl.style.display = ""
    } else if (detailEl) {
      detailEl.style.display = "none"
    }
    // final rank banner — only meaningful on a real finish, not the leaderboard view
    const rankEl = $("resFinalRank")
    if (rankEl) {
      const total = rivals.length + 1
      rankEl.classList.remove("gold", "silver", "bronze")
      const cls = rankClass(state._finalRank)
      if (cls) rankEl.classList.add(cls)
      rankEl.innerHTML = `第 <b>${state._finalRank}</b> 名 / ${total}`
      // hide rank in solo levels (no rivals)
      rankEl.style.display = (lvl && lvl.rivalCount === 0 && !lvl.ghost) ? "none" : ""
    }
    // best time + leaderboard
    const fresh = Save.get()
    const best = fresh.bestTimePerTrack[fresh.selectedTrack]
    $("resBestTime").textContent = best ? mmss(best.ms) : "--"
    const board = $("resLeaderboard")
    board.innerHTML = ""
    fresh.leaderboard
      .filter((x) => x.trackId === fresh.selectedTrack)
      .slice(0, 5)
      .forEach((row, i) => {
        const li = document.createElement("li")
        li.innerHTML = `<span>#${i + 1} · ${CAR_BY_ID[row.carId]?.name ?? row.carId}</span><b>${mmss(row.ms)}</b>`
        board.appendChild(li)
      })
    refreshCurrencyHud()
    setMode("result")
  }, 1100)
}

// ────────────────────────────────────────────────────────────────────
// main loop
// ────────────────────────────────────────────────────────────────────
function loop(now) {
  const realDt = Math.min(0.033, (now - last) / 1000)
  last = now
  // Slow-mo: scale game-update dt by state.timeScale (1 normally, 0.4 during
  // a ramp jump), and ease it back toward 1 over ~0.6s.
  const dt = realDt * state.timeScale
  if (state.timeScale < 1) {
    state.timeScale = Math.min(1, state.timeScale + realDt * 1.4)
  }

  if (state.mode === "playing") {
    updateDriving(dt, now)
    updateRivals(dt, now)
    updateGhost(dt, now)
    updatePickups(dt, now)
    updateRamps(dt, now)
    updateCheckpoints(now)
    checkTimeLimit(now)
    updateCamera(dt)
    updateHUD()
    updatePlayerFlash(now)
    updateNitroSaturation(now)
    updateSpeedRibbons(now)
    updateInvincibility(now)
    updatePlayerCarLights()
    updateNitroFlames()
    updateAuditGuard()
  } else if (state.mode === "menu" || state.mode === "boot") {
    updateMenuCamera(now)
  } else if (state.mode === "paused" || state.mode === "result") {
    updateCamera(dt * 0.4)
  }

  // background world animation always active (use real dt so background
  // motion isn't yanked into slow-mo too — it would feel wrong).
  animateScenery(realDt, now)
  updateParticles(realDt)
  setEngineLoad(state.speed, state.nitroTime > 0)
  // Direct scene render. The EffectComposer pipeline (RenderPass +
  // UnrealBloomPass + OutputPass) was producing 1 draw call / 12
  // triangles per frame after the recent material upgrades — the
  // post-process passes silently ate the scene. Until we figure out
  // which pass is broken, render straight to the canvas. Bloom is a
  // nice-to-have; visibility is not.
  renderer.render(scene, camera)
  requestAnimationFrame(loop)
}

// Flash the player car's body materials bright white briefly after a
// collision. Cached _origEmiH/_origEmiI on each material (set in
// recolorCar) lets us restore values cleanly when the window closes.
// Collision flash: was poking every material's emissive to white +
// emissiveIntensity to ~1.6. The buggy guard `!mat.userData?._origEmiH
// == null` was always false, so wheels (whose shared TIRE_MAT had no
// _origEmiH cache) ended up stuck at white #ffffff @ 0.27 and looked
// like glowing rims. Now: flash is handled by the visible-toggle in
// updateInvincibility — same window, same blink feel, never touches a
// material so wheels stay matte black and body keeps its paint.
function updatePlayerFlash(/* now */) {
  // intentionally empty: kept as a stub so the call site in loop()
  // still resolves until that line is cleaned up.
}

// Tail flame ribbons — opacity grows past 230 km/h, length stretches
// during nitro, planes face the camera each frame so they read as
// solid streaks instead of flat cards seen from the side.
function updateSpeedRibbons(now) {
  const ribbons = player?.userData?.ribbons
  if (!ribbons) return
  const speed = state.speed
  const nitroOn = state.nitroTime > 0
  let visT = clamp((speed - 230) / 75, 0, 1)
  if (nitroOn) visT = 1
  const lenScale = nitroOn ? 1.6 : 1
  const tint = nitroOn ? 0xb8f0ff : 0x66dfff
  for (const r of ribbons) {
    r.material.opacity = lerp(r.material.opacity, visT * 0.95, 0.25)
    r.material.color.setHex(tint)
    r.scale.y = lerp(r.scale.y, lenScale, 0.2)
    // Billboard: rotate the plane to face the camera in player-local
    // space. After lookAt, restore the original 90° X rotation so the
    // ribbon stays anchored along the car's +Z (length trailing back).
    const camLocal = player.worldToLocal(camera.position.clone())
    const target = new THREE.Vector3(camLocal.x, r.position.y, camLocal.z)
    r.lookAt(target)
    r.rotateX(Math.PI / 2)
  }
}

// Brief post-collision invincibility window: the player blinks for
// 500ms and ignores hazard/rival hits during that time. Implementation
// is a simple `playerBody.visible` toggle — no material mutations, so
// wheels stay matte black and body keeps its paint detail.
function updateInvincibility() {
  if (!playerBody) return
  const invincibleFrames = Math.max(0, (state.invincibleUntil ?? 0) - performance.now())
  if(invincibleFrames>0) playerBody.visible = Math.floor(performance.now()/80)%2===0; else playerBody.visible=true;
}

// CSS filter on the canvas — combines a saturation boost (when nitro
// fires) with a high-speed contrast/blur tweak above 250 km/h. Reads
// as motion blur kicking in at extreme velocity.
function updateNitroSaturation(now) {
  const cv = document.getElementById("game")
  if (!cv) return
  const filters = []
  const remaining = state.nitroSaturateUntil - now
  if (remaining > 0) {
    const t = Math.min(1, remaining / 600)
    filters.push(`saturate(${(1 + t * 0.6).toFixed(2)})`)
    filters.push(`brightness(${(1 + t * 0.12).toFixed(2)})`)
  }
  // High-speed contrast bump — past 250 km/h colours pop and a tiny
  // edge blur (via the CSS `blur()` filter ≤ 0.6px) sells the rush.
  if (state.speed > 230) {
    const v = clamp((state.speed - 230) / 80, 0, 1)
    if (v > 0) {
      filters.push(`contrast(${(1 + v * 0.18).toFixed(2)})`)
      if (v > 0.5) filters.push(`blur(${(v * 0.6).toFixed(2)}px)`)
    }
  }
  cv.style.filter = filters.join(" ")
}

// Brief white flash overlay when nitro fires. Reuses the impact flash
// element with its own keyframe class so it doesn't clobber the red
// collision flash.
function flashWhite() {
  const fx = $("screenFx")
  if (!fx) return
  fx.classList.remove("fx-impact", "fx-nitro", "fx-checkpoint", "fx-white")
  void fx.offsetWidth
  fx.classList.add("fx-white")
  setTimeout(() => fx.classList.remove("fx-white"), 450)
}

function updateDriving(dt, now) {
  // throttle / brake (uses currently-selected car's stats)
  if (state.countdown > 0) {
    state.speed = lerp(state.speed, 0, dt * 4)
  } else if (!state.finished) {
    const target = state.brake ? 0 : (state.nitroTime > 0 ? CFG.nitroSpeed : (state.gas ? CFG.maxSpeed : 95))
    const accel = state.gas ? (CFG.carAccel ?? 2.0) : 0.8
    state.speed = lerp(state.speed, target, dt * accel)
    if (state.brake) state.speed = Math.max(0, state.speed - 200 * dt)
  } else {
    state.speed = lerp(state.speed, 35, dt * 1.2)
  }
  // V1.8.3a-2: post-lerp speed cap multiplier (debug lever).
  // Default window.__tune.speedCapMultiplier = 1.0 → no-op. Set in
  // browser console to 0.55 / 0.65 / 0.75 etc. to test what feels
  // right. Cap is applied AFTER the lerp, so the 0-3s acceleration
  // rate is identical to the un-capped run; speed just plateaus
  // earlier when mul < 1.0. lerp `target` is unchanged (the kick
  // at gas-mash time is preserved). Per-car stats / per-level
  // fields / CFG.carAccel all untouched.
  const _capMul = window.__tune?.speedCapMultiplier ?? 1.0
  if (_capMul < 1.0) {
    const _baseCap = state.nitroTime > 0 ? CFG.nitroSpeed : CFG.maxSpeed
    state.speed = Math.min(state.speed, _baseCap * _capMul)
  }
  if (state.nitroTime > 0) state.nitroTime = Math.max(0, state.nitroTime - dt)

  // steering — locked during countdown
  const liveSteer = state.countdown > 0 ? 0 : state.steer
  state.steerVisual = lerp(state.steerVisual, liveSteer, dt * 6)
  const steerStrength = (CFG.carSteer ?? 6.5) + state.speed * 0.05
  state.lateral = clamp(state.lateral + liveSteer * dt * steerStrength, -CFG.playerHalfWidth, CFG.playerHalfWidth)

  // gravity / jump
  state.vy -= 32 * dt
  state.y += state.vy * dt
  if (state.y < 0.22) {
    if (state.airborne) {
      state.shake = Math.max(state.shake, 0.22)
      // Dust kick on landing — grey/brown puff at the wheels.
      const land = progressToWorld(state.progress, state.lateral, 0.3)
      sparks(land.x, land.y, land.z, 0x9a7a50, 14)
    }
    state.y = 0.22
    state.vy = 0
    state.airborne = false
  } else {
    state.airborne = true
  }

  // forward motion along the curve. speed (km/h) → m/s ≈ speed * 0.278.
  state.progress = clamp(state.progress + state.speed * dt * 0.278, 0, Track.length)
  if (state.speed > state.topSpeed) state.topSpeed = state.speed

  // map track-space → world for the player car
  const worldPos = progressToWorld(state.progress, state.lateral, state.y)
  const tan = progressTangent(state.progress).clone()
  player.position.copy(worldPos)
  // orient player to face down the curve (forward = tangent), then add steer/jump tilt
  player.lookAt(worldPos.clone().add(tan))
  player.rotation.x += -state.vy * 0.012 + (state.airborne ? 0.05 : 0)
  player.rotation.z += -state.steerVisual * 0.18
  if (playerBody) {
    // V1.8.3a-3: rotation.y = modelYawOffset (cars.js, default 0) +
    // visualYawOffset (tune.js, default Math.PI) − steerTilt. The
    // visualYawOffset is the live A/B knob; flip with
    // window.__tryFlipVisual() to test 0 vs π without rebuild.
    const yawBase = playerBody.userData.modelYawOffset ?? 0
    const visYaw = window.__tune?.visualYawOffset ?? Math.PI
    playerBody.rotation.y = yawBase + visYaw - state.steerVisual * 0.05
    const steerAngle = state.steerVisual * 0.45
    playerBody.userData.steeringPivots?.forEach((p) => { p.rotation.y = steerAngle })
    const wheelRadius = playerBody.userData.wheelRadius || 0.46
    const spin = state.speed * dt * 0.278 / wheelRadius
    playerBody.userData.rollingWheels?.forEach((wheel) => { wheel.rotation.x -= spin })
  }

  // nitro flame trail — animate each plume layer (6 cones total) with a
  // wobble + targetOp from layer config. Gives a flickering long streak.
  const plumeOn = state.nitroTime > 0
  player.userData.plumes?.forEach((p) => {
    const target = plumeOn ? p.userData.targetOp : 0
    p.material.opacity = lerp(p.material.opacity, target, plumeOn ? 0.5 : 0.18)
    p.scale.z = plumeOn ? (1 + Math.sin(now * 0.05 + p.position.x) * 0.22) : 0.4
  })
  if (headlight) headlight.intensity = lerp(headlight.intensity, plumeOn ? 1.2 : 0.5, dt * 4)
  // nitro particle trail — spawn at world rear of player
  if (plumeOn) {
    state._nitroEmitTimer = (state._nitroEmitTimer || 0) - dt
    if (state._nitroEmitTimer <= 0) {
      state._nitroEmitTimer = 0.018
      // spawn a couple of meters behind the car along -tangent
      const back = worldPos.clone().addScaledVector(tan, -3.4)
      back.x += (Math.random() - 0.5) * 1.2
      back.y += 0.45 + Math.random() * 0.2
      back.z += (Math.random() - 0.5) * 1.2
      nitroTrail(back.x, back.y, back.z, Math.random() < 0.5 ? 0x2ec8ff : 0xfff15a)
    }
  }

  // finish trigger — once we've covered the whole curve
  if (!state.finished && state.progress >= Track.length - 14) finishRace(true)
}

function updateRivals(dt, now) {
  for (const r of rivals) {
    // gap to player along the track (positive = rival ahead)
    const dProgress = r.progress - state.progress
    // Periodic random lane-change: every 3-5s a rival picks a new target
    // lane, then the existing lane-target lerp slides them over. Without
    // this rivals just hold their assigned lane and the field reads as
    // a static convoy. Skip if the rival is already mid-dodge from a
    // close-behind player.
    if (now > (r.nextLaneChangeAt ?? 0)) {
      const choices = LANE_X.filter((x) => Math.abs(x - r.laneTarget) > 0.5)
      r.laneTarget = choices[Math.floor(Math.random() * choices.length)] ?? 0
      r.nextLaneChangeAt = now + 3000 + Math.random() * 2000
    }
    // soft rubber-band so the field stays close to the player without feeling
    // scripted: rivals far behind catch up modestly, rivals far ahead coast.
    // Caps at ±18% of base speed and only kicks in past 60m of separation,
    // so direct head-to-head battles are still decided by driving.
    let bandMul = 1
    if (dProgress < -60) bandMul = 1 + Math.min(0.18, (-dProgress - 60) / 600)
    else if (dProgress > 80) bandMul = 1 - Math.min(0.14, (dProgress - 80) / 700)
    // ── style-driven mistakes (the "mistake-prone" rival occasionally lifts) ──
    if (r.knobs?.mistakeFreq > 0 && now > r.nextMistakeAt && r.speedMod === 1) {
      r.speedMod = 0.55 + Math.random() * 0.2     // 55-75% pace for a moment
      r.speedModUntil = now + 700 + Math.random() * 600
      // schedule the next mistake well after this one finishes
      r.nextMistakeAt = r.speedModUntil + 3500 + Math.random() * 5000
    }
    if (r.speedMod !== 1 && now >= r.speedModUntil) r.speedMod = 1
    r.progress += r.baseSpeed * bandMul * (r.speedMod ?? 1) * dt * 0.278
    // far behind → respawn ahead
    if (dProgress < -60) {
      r.progress = state.progress + 90 + rand(0, 80)
      const lanes = [-4, -2, 2, 4]
      r.laneTarget = lanes[Math.floor(Math.random() * lanes.length)]
      r.lateral = r.laneTarget
      r.lastHit = now
    }
    // way ahead → bring back into view
    if (dProgress > 360) {
      r.progress = state.progress + 90 + rand(0, 80)
      const lanes = [-4, -2, 2, 4]
      r.laneTarget = lanes[Math.floor(Math.random() * lanes.length)]
      r.lateral = r.laneTarget
    }
    // lane sway + dodge if player close behind in same lane.
    // Style knobs scale how wide the rival weaves and how hard it dodges.
    const k = r.knobs ?? RIVAL_STYLE.steady
    const playerCloseBehind = dProgress < 16 && dProgress > -2
    const playerAligned = Math.abs(r.lateral - state.lateral) < 1.4
    const swayAmp = 1.4 * k.swayMul + (k.bobble ?? 0)
    let lane = r.laneTarget + Math.sin(now * 0.0010 + r.swayPhase) * swayAmp
    if (playerCloseBehind && playerAligned) {
      const dodge = (state.lateral < 0 ? 2.4 : -2.4) * k.aggressionMul
      lane = clamp(r.laneTarget + dodge, -CFG.playerHalfWidth, CFG.playerHalfWidth)
    }
    r.lateral = lerp(r.lateral, lane, dt * 1.6)
    r.lateral += r.bumpVx * dt
    r.bumpVx *= Math.pow(0.05, dt)
    r.lateral = clamp(r.lateral, -CFG.playerHalfWidth, CFG.playerHalfWidth)

    // place car in world following the curve
    const wp = progressToWorld(r.progress, r.lateral, 0.22)
    const tan = progressTangent(r.progress).clone()
    r.car.position.copy(wp)
    r.car.lookAt(wp.clone().add(tan))
    // Kenney models face -Z natively, lookAt also faces -Z (same direction the
    // tangent points), so add a 180° flip to face the right way.
    r.car.rotateY(Math.PI)
    // tilt for lean
    const lean = Math.sin(now * 0.003 + r.swayPhase) * 0.05 + (r.lateral - state.lateral) * 0.02
    r.car.rotateZ(lean * 0.8)

    // collision with player (in track-space)
    if (state.finished) continue
    const sinceStart = now - state.startedAt - state.pauseAcc
    if (sinceStart < 1500) continue
    const dProg = Math.abs(dProgress)
    const dLat = Math.abs(r.lateral - state.lateral)
    if (dProg < 2.6 && dLat < 1.4 && now - r.lastHit > 1500 && now - state.lastRivalHit > 900) {
      r.lastHit = now
      state.lastRivalHit = now
      const dir = state.lateral < r.lateral ? -1 : 1
      r.bumpVx = dir * 14
      state.lateral = clamp(state.lateral - dir * 0.7, -CFG.playerHalfWidth, CFG.playerHalfWidth)
      if (state.nitroTime > 0) {
        state.speed *= 0.92
        toast("撞开对手！", 800)
      } else if (now >= (state.invincibleUntil ?? 0)) {
        state.hits++
        // V1.7.1: cut speed to 55% (with floor 80) — softer than the
        // hard-clamp-to-100 from before, more forgiving when you were
        // already cruising slow but still readable as "I just got hit".
        state.speed = Math.max(state.speed * 0.55, 80)
        state.vy = Math.max(state.vy, 4)
        state.shake = 0.5
        state.flashUntil = now + 250
        state.invincibleUntil = now + 600   // 0.6s i-frames
        toast("被撞了！稳住", 900)
        flashFx("impact")
        if (state.hits >= CFG.hitLimit) finishRace(false)
      }
      const sparkPos = progressToWorld((r.progress + state.progress) / 2, (r.lateral + state.lateral) / 2, 1.6)
      sparks(sparkPos.x, sparkPos.y, sparkPos.z, 0xffe45a, 22)
      sfxImpact()
    }
  }
}

function updatePickups(dt, now) {
  for (const p of pickups) {
    if (p.taken) continue
    if (p.type !== "hazard") {
      p.mesh.rotation.y += dt * 4
      // float-bob the y position relative to the road base height under it
      const baseY = (p.type === "nitro" ? 1.9 : 2.0) + Math.sin(now * 0.004 + p.progress) * 0.2
      const bobPos = progressToWorld(p.progress, p.lateral, baseY)
      p.mesh.position.copy(bobPos)
    }
    const dProg = Math.abs(p.progress - state.progress)
    const dLat = Math.abs(p.lateral - state.lateral)
    // Hazard hitbox is wider (visual car is ~5.5m wide post-scale-up); coins
    // and nitros stay generous so they're easy to grab when you swerve.
    const latHit = p.type === "hazard" ? 2.6 : 2.2
    const progHit = p.type === "hazard" ? 4.4 : 3.6
    if (dProg < progHit && dLat < latHit) {
      if (p.type === "coin") {
        p.taken = true
        p.mesh.visible = false
        state.coins++
        sparks(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, 0xffd23a, 10)
        sfxCoin()
        showTutorialHint("intro_coin", "收集金币解锁新赛车 🪙", 1800)
      } else if (p.type === "nitro") {
        p.taken = true
        p.mesh.visible = false
        state.nitroCharges = Math.min(3, state.nitroCharges + 1)
        toast("氮气 +1", 800)
        sparks(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, 0xffe45a, 18)
        sfxCoin()
        showTutorialHint("intro_nitro",
          isTouchDevice() ? "双击屏幕或点击 ⚡ 使用氮气加速" : "按空格使用氮气加速 ⚡",
          2200)
      } else if (p.type === "hazard" && state.nitroTime <= 0 && now >= (state.invincibleUntil ?? 0)) {
        p.taken = true
        p.mesh.visible = false
        state.hits++
        state.speed = Math.max(state.speed * 0.55, 80)
        state.vy = Math.max(state.vy, 4)
        state.shake = 0.5
        state.flashUntil = now + 250
        state.invincibleUntil = now + 600   // 0.6s i-frames
        toast("撞到障碍！", 900)
        flashFx("impact")
        sparks(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, 0xff7a18, 32)
        sfxImpact()
        if (state.hits >= CFG.hitLimit) finishRace(false)
      }
    }
  }
}

function updateRamps(dt, now) {
  for (const r of ramps) {
    if (r.used) continue
    const dProg = Math.abs(r.progress - state.progress)
    const dLat = Math.abs(r.lateral - state.lateral)
    if (dProg < 4.6 && dLat < 3.0 && state.y <= 0.4) {
      r.used = true
      const power = state.nitroTime > 0 ? 22 : 17
      state.vy = power
      state.airborne = true
      state.shake = 0.32
      // Cinematic slow-mo punch — dt scaled to 0.4 in the loop, ramps back
      // to 1 over ~0.6s. Sells the launch as a hero moment.
      state.timeScale = 0.4
      const sparkPos = progressToWorld(r.progress, r.lateral, 1.0)
      sparks(sparkPos.x, sparkPos.y, sparkPos.z, 0xffd23a, 24)
      toast(state.nitroTime > 0 ? "超级飞跃！" : "飞跃！", 900)
      if (state.nitroCharges < 3) state.nitroCharges = Math.min(3, state.nitroCharges + 1)
    }
  }
}

// Drive the ghost pacer along the spline at its constant speed. Mark
// `state.beatGhost` true the first frame the player overtakes it.
function updateGhost(dt, now) {
  const g = state.ghost
  if (!g || state.finished) return
  // ghost only moves once the GO! has fired so the player isn't chasing
  // from -100m while still on the start light.
  if (state.countdown > 0) return
  g.progress += g.speed * dt * 0.278
  // clamp at finish so it doesn't fly off the end of the curve
  g.progress = Math.min(g.progress, Track.length - 6)
  const pos = progressToWorld(g.progress, 0, 0.22)
  const tan = progressTangent(g.progress).clone()
  g.car.position.copy(pos)
  g.car.lookAt(pos.clone().add(tan))
  g.car.rotateY(Math.PI)
  // bobbing ghost shimmer
  g.car.position.y += 0.06 * Math.sin(now * 0.006)
  if (!state.beatGhost && state.progress >= g.progress - g.catchDistance) {
    state.beatGhost = true
    toast("追上目标车！", 1100)
    flashFx("checkpoint")
  }
}

// Force-finish (with `success=false`) when level.timeLimit elapses.
function checkTimeLimit(now) {
  const limit = state.level?.timeLimit ?? 0
  if (limit <= 0 || state.finished || state.countdown > 0) return
  const elapsed = (now - state.startedAt - state.pauseAcc) / 1000
  if (elapsed >= limit) {
    state.timedOut = true
    toast("时间到", 1100)
    finishRace(false)
  }
}

function updateCheckpoints(now) {
  for (const c of checkpoints) {
    if (c.passed) continue
    if (state.progress > c.progress) {
      c.passed = true
      const pos = progressToWorld(c.progress, 0, 4.5)
      sparks(pos.x, pos.y, pos.z, 0x2ec8ff, 28)
      toast("通过检查点！", 800)
      flashFx("checkpoint")
      sfxCheckpoint()
      state.nitroCharges = Math.min(3, state.nitroCharges + 1)
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// camera
// ────────────────────────────────────────────────────────────────────
function updateCamera(dt) {
  // V1.8.7: chase camera follows the player's ACTUAL movement direction
  // (frame-to-frame world-space displacement), not player.quaternion's
  // local -Z. The previous quaternion-based forward turned out to point
  // in the OPPOSITE direction of motion in playing mode (measured:
  // dot(cameraOffset, actualMovement) = +0.998 → camera was rendering
  // in front of the car). Deriving direction from displacement is
  // immune to whichever +Z/-Z convention the visual chain ends up at.
  //
  // Tunables (per spec):
  const followDist = 7.5
  const camHeight  = 3.4
  const lookAhead  = 10.0

  // 1) Update lastValidMoveDir from the frame-to-frame displacement.
  if (_camLastPlayerPosInit) {
    tmpVec.subVectors(player.position, _camLastPlayerPos)  // moveDelta
    const len = tmpVec.length()
    if (len > 0.05) {
      _camLastValidMoveDir.copy(tmpVec).divideScalar(len)
    }
    // else: keep prior lastValidMoveDir, no overwrite on tiny / no motion
  } else {
    _camLastPlayerPosInit = true
  }
  _camLastPlayerPos.copy(player.position)

  // 2) First-frame fallback: if lastValidMoveDir hasn't been seeded yet
  // (or somehow degenerated to zero), use the spline tangent so the
  // initial camera placement isn't undefined. Explicitly NOT visual
  // model direction — keep the camera independent of any GLB axis.
  if (_camLastValidMoveDir.lengthSq() < 0.0001) {
    if (typeof Track !== "undefined" && Track && Track.curve) {
      progressToWorld(Math.min(state.progress + 1, Track.length), state.lateral, state.y, tmpVec)
      _camLastValidMoveDir.subVectors(tmpVec, player.position)
      if (_camLastValidMoveDir.lengthSq() > 0.0001) {
        _camLastValidMoveDir.normalize()
      } else {
        _camLastValidMoveDir.set(0, 0, -1)  // last-resort: world -Z
      }
    } else {
      _camLastValidMoveDir.set(0, 0, -1)
    }
  }

  // 3) Place the camera BEHIND the move direction at followDist.
  //    targetPos = player.position - moveDir * followDist + (0, camHeight, 0)
  _camTargetPos.copy(player.position)
    .addScaledVector(_camLastValidMoveDir, -followDist)
  _camTargetPos.y += camHeight

  // 4) Camera shake (preserved from prior camera). Decays state.shake
  // and adds a small random offset to the target position.
  if (state.shake > 0) {
    state.shake = Math.max(0, state.shake - dt)
    const k = state.shake
    const amp = 0.7 + k * 1.4
    _camTargetPos.x += (Math.random() - 0.5) * amp
    _camTargetPos.y += (Math.random() - 0.5) * amp * 0.6
    _camTargetPos.z += (Math.random() - 0.5) * amp * 0.4
  }

  // 5) Smooth chase via per-frame lerp(0.12) per spec. (Not framerate-
  // independent; matches the spec exactly so the visual feel can be
  // tuned by the human verifier without compounding maths.)
  camera.position.lerp(_camTargetPos, 0.12)

  // 6) Look ahead of the player along the same move direction.
  //    targetLook = player.position + moveDir * lookAhead + (0, 1.0, 0)
  _camLookAt.copy(player.position)
    .addScaledVector(_camLastValidMoveDir, lookAhead)
  _camLookAt.y += 1.0
  camera.lookAt(_camLookAt)
}

function updateMenuCamera(now) {
  // gentle orbit around player at start grid
  const t = now * 0.00018
  const r = 22
  camera.position.set(Math.sin(t) * r, 7 + Math.sin(t * 1.3) * 1.4, 26 + Math.cos(t) * 10)
  camera.lookAt(0, 2.4, 0)
}

// ────────────────────────────────────────────────────────────────────
// HUD
// ────────────────────────────────────────────────────────────────────

// Player rank: 1 = leader. 1 + count of rivals further along the spline.
function computeRank() {
  let ahead = 0
  for (const r of rivals) if (r.progress > state.progress) ahead++
  return ahead + 1
}

// English ordinal suffix (used in the RANK chip — "1ST" / "2ND" / "3RD" / "4TH"…)
function ordinalSuffix(n) {
  const v = n % 100
  if (v >= 11 && v <= 13) return "TH"
  switch (n % 10) {
    case 1: return "ST"
    case 2: return "ND"
    case 3: return "RD"
    default: return "TH"
  }
}

function rankClass(rank) {
  if (rank === 1) return "gold"
  if (rank === 2) return "silver"
  if (rank === 3) return "bronze"
  return ""
}

function updateRankBadge() {
  const badge = $("rankBadge")
  if (!badge) return
  const rank = state.finished && state._finalRank != null ? state._finalRank : computeRank()
  $("hudRank").textContent = String(rank)
  $("hudRankSuffix").textContent = ordinalSuffix(rank)
  badge.classList.remove("gold", "silver", "bronze")
  const cls = rankClass(rank)
  if (cls) badge.classList.add(cls)
  // ── overtake / overtaken toast ──
  // Throttle to one toast per 1.2s so a brief rank flicker doesn't spam.
  const now = performance.now()
  if (state._lastRank == null) {
    state._lastRank = rank
  } else if (rank !== state._lastRank && !state.finished && state.countdown === 0) {
    if (now - state._lastOvertakeAt > 1200) {
      if (rank < state._lastRank) {
        toast("超车！+1 RANK", 900)
        flashFx("checkpoint")
      } else if (rank > state._lastRank) {
        toast("被超车！", 900)
      }
      state._lastOvertakeAt = now
    }
    state._lastRank = rank
  }
}

// Sync the mini-map: ensure one .mini-rival per rival, place player + rivals
// vertically by their progress fraction along the curve.
function updateMiniMap(progress) {
  const map = $("miniMap")
  if (!map) return
  // ensure rival dots exist (created lazily, kept across frames)
  let rivalDots = map.querySelectorAll(".mini-rival")
  if (rivalDots.length !== rivals.length) {
    // remove old, add new
    map.querySelectorAll(".mini-rival").forEach((d) => d.remove())
    for (let i = 0; i < rivals.length; i++) {
      const d = document.createElement("span")
      d.className = "mini-dot mini-rival"
      map.appendChild(d)
    }
    rivalDots = map.querySelectorAll(".mini-rival")
  }
  for (let i = 0; i < rivals.length; i++) {
    const pct = clamp(rivals[i].progress / Track.length, 0, 1)
    rivalDots[i].style.top = `${pct * 100}%`
  }
  const player = $("miniPlayer")
  if (player) player.style.top = `${progress * 100}%`
}

// Speed lines overlay: opacity scales with speed, switches to cyan during
// nitro. Per spec: invisible below 200 km/h, ramps 0→0.6 between 200 and
// 305 km/h, full 1.0 during nitro.
function updateSpeedLines() {
  const el = $("speedLines")
  if (!el) return
  const speedRatio = clamp((state.speed - 200) / 105, 0, 1) * 0.6
  const nitro = state.nitroTime > 0
  const intensity = nitro ? 1 : speedRatio
  el.style.setProperty("--speed-fx", intensity.toFixed(3))
  el.classList.toggle("active", intensity > 0.05)
  el.classList.toggle("nitro", nitro)
  // V1.7.1: during nitro, force opacity to 1.0 directly (the .nitro CSS
  // class also targets opacity 1, but a direct inline override beats any
  // accidental fade from animations or transitions still in flight).
  el.style.opacity = nitro ? "1" : ""
}

// Build twin blue-flame planes anchored behind the rear bumper. Hidden
// (opacity 0) by default; updateNitroFlames brings them up to 0.95
// during nitro and billboards them toward the camera every frame so
// the planes always read as solid streaks instead of edge-on cards.
function attachNitroFlames(car) {
  const body = car.getObjectByName("body")
  if (!body) return
  body.geometry.computeBoundingBox()
  const bb = body.geometry.boundingBox
  const tailZ = bb.max.z + 0.5
  const halfW = (bb.max.x - bb.min.x) * 0.28
  const yMid  = bb.min.y + (bb.max.y - bb.min.y) * 0.30
  // Single flame texture — additive blending, vertical gradient blue→white→transparent
  const flameTex = (() => {
    const cv = document.createElement("canvas")
    cv.width = 16
    cv.height = 128
    const g = cv.getContext("2d")
    const grd = g.createLinearGradient(0, 128, 0, 0)
    grd.addColorStop(0.00, "rgba(255, 255, 255, 1.0)")    // hot white at the bumper
    grd.addColorStop(0.25, "rgba(140, 220, 255, 0.85)")
    grd.addColorStop(0.65, "rgba(38, 120, 255, 0.45)")
    grd.addColorStop(1.00, "rgba(20, 60, 200, 0.00)")     // fades to nothing
    g.fillStyle = grd
    g.fillRect(0, 0, 16, 128)
    const t = new THREE.CanvasTexture(cv)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  })()
  const flames = []
  for (const sx of [-halfW, halfW]) {
    const mat = new THREE.MeshBasicMaterial({
      map: flameTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    })
    const flame = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 4), mat)
    flame.position.set(sx, yMid, tailZ)
    body.add(flame)
    flames.push(flame)
  }
  car.userData.nitroFlames = flames
}

// Per-frame: opacity ramps with nitro state, planes billboard toward
// the camera. Anchor stays glued to the rear bumper because the planes
// are children of `body`.
function updateNitroFlames() {
  const flames = playerBody?.userData?.nitroFlames
  if (!flames || !flames.length) return
  const on = state.nitroTime > 0
  const target = on ? 0.95 : 0
  for (const f of flames) {
    f.material.opacity = lerp(f.material.opacity, target, on ? 0.5 : 0.18)
    if (camera) {
      // Billboard: rotate the plane to face the camera in body-local space.
      // Re-apply the X 90° flip to keep the plane oriented "tall" with its
      // length stretching back along +Z (behind the car).
      const camLocal = f.parent.worldToLocal(camera.position.clone())
      f.lookAt(camLocal)
    }
  }
}

// One-shot screen flash. kind: "impact" | "nitro" | "checkpoint"
let _screenFxTimer = 0
function flashFx(kind) {
  const fx = $("screenFx")
  if (!fx) return
  fx.classList.remove("fx-impact", "fx-nitro", "fx-checkpoint")
  // force reflow so the next animation restarts cleanly even on rapid retriggers
  void fx.offsetWidth
  fx.classList.add(`fx-${kind}`)
  clearTimeout(_screenFxTimer)
  _screenFxTimer = setTimeout(() => fx.classList.remove(`fx-${kind}`), 750)
}

function updateHUD() {
  $("speed").textContent = Math.round(state.speed)
  $("nitroCount").textContent = state.nitroCharges
  const progress = clamp(state.progress / Track.length, 0, 1)
  $("missionFill").style.width = `${Math.round(progress * 100)}%`
  $("missionStats").textContent = `金币 ${state.coins}/${CFG.coinGoal} · 碰撞 ${state.hits}/${CFG.hitLimit}`
  // top centred chips: RANK / TIME / COIN / TRACK.
  // If the active level has a time limit, TIME counts down and turns red
  // in the last 10 seconds so the player feels the pressure.
  const elapsedMs = state.countdown > 0
    ? 0
    : Math.max(0, performance.now() - state.startedAt - state.pauseAcc)
  const limit = state.level?.timeLimit ?? 0
  if ($("hudTime")) {
    if (limit > 0) {
      const remainMs = Math.max(0, limit * 1000 - elapsedMs)
      $("hudTime").textContent = mmss(remainMs)
      const chip = $("hudTime").parentElement
      chip?.classList.toggle("hud-chip-time-low", remainMs < 10000)
    } else {
      $("hudTime").textContent = mmss(elapsedMs)
      $("hudTime").parentElement?.classList.remove("hud-chip-time-low")
    }
  }
  if ($("hudCoins")) $("hudCoins").textContent = String(state.coins)
  if ($("hudTrack")) {
    const lvl = state.level
    $("hudTrack").textContent = lvl ? `第 ${lvl.num} 关` : ""
  }
  updateRankBadge()
  updateMiniMap(progress)
  updateSpeedLines()
  // nitro button state: ready (pulsing), firing (cyan), or empty (grey)
  const nitroBtn = $("nitroBtn")
  const nitroWrap = $("nitroBtn").parentElement
  if (state.nitroTime > 0) {
    nitroBtn.classList.add("firing")
    nitroBtn.classList.remove("ready")
    nitroWrap.classList.remove("empty")
  } else if (state.nitroCharges > 0) {
    nitroBtn.classList.add("ready")
    nitroBtn.classList.remove("firing")
    nitroWrap.classList.remove("empty")
  } else {
    nitroBtn.classList.remove("ready", "firing")
    nitroWrap.classList.add("empty")
  }
  if (performance.now() < state.toastUntil) {
    $("missionToast").textContent = state.toastText
    $("missionToast").classList.add("show")
  } else {
    $("missionToast").classList.remove("show")
  }
}

function toast(text, ms) {
  state.toastText = text
  state.toastUntil = performance.now() + ms
}

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

// ────────────────────────────────────────────────────────────────────
// scenery animation & particles
// ────────────────────────────────────────────────────────────────────
function animateScenery(dt, now) {
  for (const obj of world.children) {
    if (obj.userData?.fan) obj.userData.fan.rotation.z += dt * obj.userData.fan.userData.spin * 4
    if (obj.userData?.bobSeed !== undefined) {
      obj.position.y = obj.position.y + Math.sin(now * 0.002 + obj.userData.bobSeed) * dt * 0.6
      obj.rotation.y += dt * 0.4
    }
  }
  updateRain(dt)
}

// One streamy puff that drifts BACKWARD (positive z = away from player) and
// gently up; used for nitro afterburn trail.
function nitroTrail(x, y, z, color) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.18 + Math.random() * 0.12, 8, 6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending })
  )
  m.position.set(x, y, z)
  m.userData = {
    vx: (Math.random() - 0.5) * 1.6,
    vy: 0.8 + Math.random() * 1.4,
    vz: 18 + Math.random() * 12,    // strong backward
    life: 0.45 + Math.random() * 0.3,
    max: 0.75,
    grow: 1.4 + Math.random() * 0.6
  }
  particles.add(m)
}

function sparks(x, y, z, color, n) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.08 + Math.random() * 0.1, 6, 5),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending })
    )
    m.position.set(x, y, z)
    m.userData = {
      vx: (Math.random() - 0.5) * 12,
      vy: 3 + Math.random() * 7,
      vz: (Math.random() - 0.5) * 12,
      life: 0.5 + Math.random() * 0.4,
      max: 0.9
    }
    particles.add(m)
  }
}

function updateParticles(dt) {
  for (let i = particles.children.length - 1; i >= 0; i--) {
    const p = particles.children[i]
    p.position.x += p.userData.vx * dt
    p.position.y += p.userData.vy * dt
    p.position.z += p.userData.vz * dt
    if (p.userData.grow) {
      p.scale.multiplyScalar(1 + p.userData.grow * dt)
      p.userData.vy *= 0.92
      p.userData.vx *= 0.92
    } else {
      p.userData.vy -= 14 * dt
    }
    p.userData.life -= dt
    p.material.opacity = clamp(p.userData.life / p.userData.max, 0, 1)
    if (p.userData.life <= 0) particles.remove(p)
  }
}

function isRotatedPortrait() {
  return false
}

function resize() {
  if (!renderer) return
  const rot = isRotatedPortrait()
  const w = rot ? innerHeight : innerWidth
  const h = rot ? innerWidth : innerHeight
  if (w < 50 || h < 50) return
  if (camera) {
    camera.aspect = w / h
    camera.fov = w > h ? 60 : 70
    camera.updateProjectionMatrix()
  }
  renderer.setSize(w, h)
  if (composer) composer.setSize(w, h)
  if (bloomPass) bloomPass.setSize(w, h)
}

function setStageScale() {
  document.documentElement.style.setProperty("--stage-scale", "1")
}

// Wire the rotate-gate's "我知道了" button. We try the orientation-lock APIs
// for the browsers that support them (Android Chrome in fullscreen), but
// always fall through to dismissing the gate — iOS Safari doesn't expose
// screen.orientation.lock at all, and the WeChat in-app browser refuses to
// rotate even when the device is rotated. Without an unconditional dismiss
// the click is a silent no-op and the user is permanently stuck on the gate.
function bindRotateGate() {
  const btn = document.getElementById("rotateAck")
  if (!btn) return
  btn.addEventListener("click", async () => {
    btn.blur()
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen().catch(() => {})
      }
      if (screen.orientation && typeof screen.orientation.lock === "function") {
        await screen.orientation.lock("landscape").catch(() => {})
      }
    } catch (_) {
      // lock unsupported (iOS / WeChat) — fall through to manual dismiss
    }
    document.body.classList.add("gate-dismissed")
    // Recompute scale + WebGL viewport against the (possibly swapped) target
    // dimensions so the game renders correctly in the rotated portrait shim.
    setStageScale()
    if (typeof resize === "function") resize()
  })
}

// register service worker (PWA offline cache)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  })
}

// Parse a ?challenge=lv1_38s_S URL param (shared from another player's
// run) and surface a banner inviting the recipient to beat the time.
// Lives outside init so it fires immediately, even before assets load.
function showChallengeBannerFromURL() {
  const banner = document.getElementById("challengeBanner")
  const text = document.getElementById("challengeBannerText")
  if (!banner || !text) return
  const params = new URLSearchParams(location.search)
  const c = params.get("challenge")
  if (!c) return
  const m = c.match(/^(lv\d+)_(\d+)s_([SABC])$/i)
  if (!m) return
  const [, lvId, sec, grade] = m
  // Try to look up the level name from the LEVELS catalogue (loaded async),
  // but don't block the banner — fall back to "第 N 关" if lookup fails.
  const num = parseInt(lvId.slice(2), 10) || 1
  text.textContent = `你的朋友用 ${sec} 秒 ${grade.toUpperCase()} 级通关了第 ${num} 关，你能打败他吗？`
  banner.classList.add("visible")
}
showChallengeBannerFromURL()

// init with friendly error UI on hard failure
init().catch((err) => {
  console.error("init failed", err)
  // Splash overlay was removed; surface init errors as a centred banner
  // appended to the body so the user isn't staring at a blank canvas.
  const banner = document.createElement("div")
  banner.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:300;background:#1a0606;color:#ffd0d0;padding:14px 22px;border:1px solid #ff5a5a;border-radius:10px;font-size:14px;text-align:center"
  banner.innerHTML = '加载失败 — <a href="javascript:location.reload()" style="color:#ffd31a;text-decoration:underline">点这里重试</a>'
  document.body.appendChild(banner)
})
