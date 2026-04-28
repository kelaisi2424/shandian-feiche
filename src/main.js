import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js"
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js"
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js"
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js"
import { Save } from "./save.js"
import "./styles.css"

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

// 3 selectable cars: id, label, GLB asset, body color, accent, stats (1-5)
const CARS = {
  sport: {
    id: "sport",
    label: "电光跑车",
    asset: "raceFuture",
    body: 0x18b6ff,
    accent: 0x05213d,
    cost: 0,
    maxSpeed: 215,
    nitroSpeed: 305,
    accel: 2.0,
    steerRate: 7.5,
    grip: 4
  },
  future: {
    id: "future",
    label: "极速未来",
    asset: "race",
    body: 0xff5826,
    accent: 0x4a0808,
    cost: 800,
    maxSpeed: 240,
    nitroSpeed: 330,
    accel: 1.7,
    steerRate: 6.3,
    grip: 3
  },
  sedan: {
    id: "sedan",
    label: "灵敏小钢炮",
    asset: "sedanSports",
    body: 0x9be32a,
    accent: 0x143807,
    cost: 1500,
    maxSpeed: 195,
    nitroSpeed: 285,
    accel: 2.4,
    steerRate: 9.2,
    grip: 5
  }
}

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
    desc: "夜间高速",
    cost: 1200,
    length: 3000,
    sky: 0x0a1338,
    fog: [0x0a1338, 200, 760],
    sun: 0xb0e0ff,
    edgeMode: "chevron",
    rampGap: 130
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
  countdown: 0
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
let player, playerBody, nitroPlume, headlight
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

  // engine: two saw oscillators slightly detuned + lowpass + gain
  const osc1 = audio.ctx.createOscillator()
  const osc2 = audio.ctx.createOscillator()
  osc1.type = "sawtooth"
  osc2.type = "square"
  osc1.frequency.value = 60
  osc2.frequency.value = 90
  const lp = audio.ctx.createBiquadFilter()
  lp.type = "lowpass"
  lp.frequency.value = 900
  const eg = audio.ctx.createGain()
  eg.gain.value = 0
  osc1.connect(lp)
  osc2.connect(lp)
  lp.connect(eg)
  eg.connect(audio.master)
  osc1.start()
  osc2.start()
  audio.engine = { osc1, osc2, gain: eg, lp }

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
  // map 0..305 km/h to 50..420 Hz on osc1 (and osc2 = osc1 * 1.5)
  const f = 50 + (speedKmh / 305) * 360
  audio.engine.osc1.frequency.setTargetAtTime(f, audio.ctx.currentTime, 0.05)
  audio.engine.osc2.frequency.setTargetAtTime(f * 1.5, audio.ctx.currentTime, 0.05)
  audio.engine.lp.frequency.setTargetAtTime(700 + (speedKmh / 305) * 1500, audio.ctx.currentTime, 0.08)
  audio.engine.gain.gain.setTargetAtTime(state.mode === "playing" ? (nitroOn ? 0.35 : 0.22) : 0, audio.ctx.currentTime, 0.1)
  audio.windGain.gain.setTargetAtTime(state.mode === "playing" ? Math.min(0.18, speedKmh / 305 * 0.18) : 0, audio.ctx.currentTime, 0.15)
}

function sfxImpact() {
  if (!audio.ctx) return
  const now = audio.ctx.currentTime
  // short metallic noise burst
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

function sfxCoin() {
  if (!audio.ctx) return
  const now = audio.ctx.currentTime
  const osc = audio.ctx.createOscillator()
  osc.type = "triangle"
  osc.frequency.setValueAtTime(880, now)
  osc.frequency.linearRampToValueAtTime(1320, now + 0.06)
  const g = audio.ctx.createGain()
  g.gain.setValueAtTime(0.18, now)
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.18)
  osc.connect(g); g.connect(audio.master)
  osc.start(now); osc.stop(now + 0.2)
}
const tmpVec = new THREE.Vector3()
const cameraTarget = new THREE.Vector3()
const cameraLook = new THREE.Vector3()

// ────────────────────────────────────────────────────────────────────
// init
// ────────────────────────────────────────────────────────────────────
async function init() {
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

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x9bd0f6)
  scene.fog = new THREE.Fog(0x9bd0f6, 220, 760)

  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1500)
  camera.position.set(0, 6, 30)
  scene.add(track, world, dynamic, particles)

  scene.add(new THREE.HemisphereLight(0xfff7d6, 0x3d72b3, 1.7))
  const sun = new THREE.DirectionalLight(0xfff5d8, 2.8)
  sun.position.set(110, 140, 60)
  scene.add(sun)
  const fill = new THREE.DirectionalLight(0x9ed8ff, 0.8)
  fill.position.set(-60, 30, -120)
  scene.add(fill)

  // env map for car paint reflections — procedural "studio sky + ground" via PMREM
  const pmrem = new THREE.PMREMGenerator(renderer)
  pmrem.compileEquirectangularShader()
  const envCanvas = document.createElement("canvas")
  envCanvas.width = 256
  envCanvas.height = 128
  const ec = envCanvas.getContext("2d")
  const sky = ec.createLinearGradient(0, 0, 0, 128)
  sky.addColorStop(0, "#cfe6ff")
  sky.addColorStop(0.55, "#88baff")
  sky.addColorStop(0.6, "#3b69aa")
  sky.addColorStop(1, "#1f3050")
  ec.fillStyle = sky
  ec.fillRect(0, 0, 256, 128)
  // hot soft sun
  const sunG = ec.createRadialGradient(180, 30, 0, 180, 30, 38)
  sunG.addColorStop(0, "rgba(255,250,210,1)")
  sunG.addColorStop(1, "rgba(255,250,210,0)")
  ec.fillStyle = sunG
  ec.fillRect(120, 0, 130, 60)
  const envTex = new THREE.CanvasTexture(envCanvas)
  envTex.mapping = THREE.EquirectangularReflectionMapping
  envTex.colorSpace = THREE.SRGBColorSpace
  const envMap = pmrem.fromEquirectangular(envTex).texture
  scene.environment = envMap
  envTex.dispose()
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
  addEventListener("resize", resize)
  // expose for debugging
  window.__state = state
  window.__Track = Track
  window.__player = player

  // assets ready → flick the splash off into the menu
  $("splashStatus").textContent = "准备就绪"
  setTimeout(() => {
    $("splash").classList.add("fade-out")
    setTimeout(() => {
      $("splash").classList.remove("active", "fade-out")
      setMode("menu")
      maybeShowDailyBonus()
    }, 600)
  }, 350)

  requestAnimationFrame(loop)
}

// ────────────────────────────────────────────────────────────────────
// materials & textures
// ────────────────────────────────────────────────────────────────────
function buildMaterials() {
  mats.roadCenter = new THREE.MeshStandardMaterial({
    map: roadCenterTexture(),
    roughness: 0.55,
    metalness: 0.05,
    envMapIntensity: 0.15
  })
  mats.roadEdge = new THREE.MeshStandardMaterial({
    map: roadEdgeTexture(),
    roughness: 0.45,
    metalness: 0.08,
    envMapIntensity: 0.2
  })
  mats.roadEdgeR = new THREE.MeshStandardMaterial({
    map: roadEdgeTexture(true),
    roughness: 0.45,
    metalness: 0.08,
    envMapIntensity: 0.2
  })
  mats.rail = new THREE.MeshStandardMaterial({
    color: 0x0e63b8,
    roughness: 0.32,
    metalness: 0.45
  })
  mats.railTop = new THREE.MeshStandardMaterial({
    color: 0xffd11a,
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
    color: 0x36e0ff,
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
  // base yellow
  g.fillStyle = "#ffd31a"
  g.fillRect(0, 0, 512, 512)
  // diamond-plate raised dots — the small bumps you see on the screenshot road.
  // Two-pass: dark shadow disk + bright highlight disk offset by 1px → 3D feel.
  const cell = 22
  for (let y = -cell; y < 512 + cell; y += cell) {
    for (let x = (y / cell) % 2 === 0 ? 0 : cell / 2; x < 512 + cell; x += cell) {
      g.fillStyle = "rgba(150, 100, 0, 0.45)"
      g.beginPath()
      g.arc(x + 1, y + 1, 4.5, 0, Math.PI * 2)
      g.fill()
      const grd = g.createRadialGradient(x - 0.5, y - 0.5, 0, x, y, 4.6)
      grd.addColorStop(0, "rgba(255, 250, 200, 0.95)")
      grd.addColorStop(0.6, "rgba(255, 220, 90, 0.7)")
      grd.addColorStop(1, "rgba(255, 200, 40, 0)")
      g.fillStyle = grd
      g.beginPath()
      g.arc(x, y, 4.6, 0, Math.PI * 2)
      g.fill()
    }
  }
  // centre dashed white lane stripes (strong)
  g.fillStyle = "rgba(255, 255, 255, 0.85)"
  for (let i = 0; i < 512; i += 96) g.fillRect(244, i + 12, 24, 64)
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
  const items = {
    raceFuture: "/models/race-future.glb",
    race: "/models/race.glb",
    sedanSports: "/models/sedan-sports.glb",
    cone: "/models/cone.glb",
    box: "/models/box.glb",
    flagCheckers: "/models/racing/flagCheckers.gltf",
    flagRed: "/models/racing/flagRed.gltf",
    flagGreen: "/models/racing/flagGreen.gltf",
    overhead: "/models/racing/overheadRoundColored.gltf",
    barrierRed: "/models/racing/barrierRed.gltf",
    barrierWhite: "/models/racing/barrierWhite.gltf",
    pylon: "/models/racing/pylon.gltf",
    rampKit: "/models/racing/ramp.gltf",
    grandStand: "/models/racing/grandStand.gltf",
    treeLarge: "/models/racing/treeLarge.gltf",
    billboard: "/models/racing/billboard.gltf"
  }
  const entries = Object.entries(items)
  const total = entries.length
  let done = 0
  const setProgress = (label) => {
    const fill = $("splashFill")
    const status = $("splashStatus")
    const pct = Math.round((done / total) * 100)
    if (fill) fill.style.width = `${pct}%`
    if (status) status.textContent = label || `加载资源 ${pct}%`
  }
  setProgress("加载资源 0%")
  const results = []
  for (const [k, url] of entries) {
    try {
      const g = await loader.loadAsync(url)
      results.push([k, g.scene])
    } catch (e) {
      console.warn("asset missing", url, e)
      results.push([k, null])
    }
    done++
    setProgress(`加载资源 ${Math.round(done / total * 100)}%`)
  }
  assets = Object.fromEntries(results)
}

function cloneAsset(name, targetSize, axis = "x") {
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
  const scale = targetSize / Math.max(0.001, dim)
  const wrap = new THREE.Group()
  wrap.add(clone)
  wrap.scale.setScalar(scale)
  const wrapBox = new THREE.Box3().setFromObject(wrap)
  wrap.position.y -= wrapBox.min.y
  return wrap
}

// Recolor only the bright body panels of a Kenney car GLB, leaving glass / wheels / lights alone.
// Kenney car materials use a small palette via the `colormap.png` texture, so we look at the
// existing material color and only repaint the parts that read as "body paint" (mid-bright,
// roughly grey/neutral or saturated). Tires / windows / chrome are left intact.
function recolorCar(asset, opts = {}) {
  const body = new THREE.Color(opts.body ?? 0x18b6ff)
  const accent = new THREE.Color(opts.accent ?? 0x081a36)
  asset.traverse((m) => {
    if (!m.isMesh || !m.material) return
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    for (let i = 0; i < mats.length; i++) {
      const mat = mats[i].clone()
      if (mat.color) {
        const hsl = { h: 0, s: 0, l: 0 }
        mat.color.getHSL(hsl)
        if (hsl.l > 0.35 && hsl.l < 0.92) {
          if (hsl.s < 0.55 || hsl.l > 0.55) {
            mat.color.copy(body)
            mat.map = null      // drop Kenney palette texture so paint reads pure
          } else {
            mat.color.copy(accent)
          }
        }
      }
      mat.metalness = Math.max(mat.metalness ?? 0.2, 0.6)
      mat.roughness = Math.min(mat.roughness ?? 0.5, 0.28)
      mats[i] = mat
    }
    m.material = Array.isArray(m.material) ? mats : mats[0]
    m.castShadow = true
  })
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
function buildSky() {
  // gradient backdrop dome
  const geo = new THREE.SphereGeometry(900, 32, 16)
  const tex = (() => {
    const c = document.createElement("canvas")
    c.width = 16
    c.height = 256
    const g = c.getContext("2d")
    const grd = g.createLinearGradient(0, 0, 0, 256)
    grd.addColorStop(0, "#9ed3f6")
    grd.addColorStop(0.55, "#cce8fc")
    grd.addColorStop(0.9, "#e0f1ff")
    grd.addColorStop(1, "#f3f9ff")
    g.fillStyle = grd
    g.fillRect(0, 0, 16, 256)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  })()
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false }))
  scene.add(dome)

  // a few drifting clouds
  for (let i = 0; i < 24; i++) {
    const cl = makeCloud()
    cl.position.set(rand(-260, 260), rand(40, 90), rand(-1200, 200))
    cl.scale.setScalar(rand(0.8, 2.2))
    world.add(cl)
  }
}

function makeCloud() {
  const g = new THREE.Group()
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, fog: false })
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
  const tCfg = TRACKS[Save.get().selectedTrack] ?? TRACKS.sky
  const totalLen = tCfg.length
  const points = []
  // start: 24m back from origin so the start gantry has space behind player
  points.push(new THREE.Vector3(0, 0, 24))
  const wobble = tCfg.id === "neon" ? 36 : tCfg.id === "sunset" ? 26 : 18
  const hills = tCfg.id === "neon" ? 2.6 : tCfg.id === "sunset" ? 2.0 : 1.4
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

  // big start-line zebra stripe + periodic narrower stripes
  for (let s = 6; s < Track.length; s += 64) {
    const isStart = s === 6
    const wide = isStart ? 3.4 : 1.2
    const stripeMat = isStart
      ? new THREE.MeshStandardMaterial({ color: 0x1392ff, emissive: 0x0a4a8a, emissiveIntensity: 0.18, roughness: 0.35 })
      : new THREE.MeshStandardMaterial({ color: 0x1392ff, roughness: 0.4 })
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
  const g = new THREE.Group()
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
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4400, 4400),
    new THREE.MeshStandardMaterial({ color: 0x4d8bc4, roughness: 0.95 })
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.set(0, -60, -Track ? -Track.length / 2 : -700)
  sceneryAdd(ground)

  // turbines + trusses placed along the curve: every ~80m, alternating sides,
  // so they follow the track instead of drifting off into nothing.
  const turbineCount = Math.floor(Track.length / 90)
  for (let i = 0; i < turbineCount; i++) {
    const fan = makeTurbine(i)
    const side = i % 2 ? -1 : 1
    const s = 60 + i * 90
    if (s >= Track.length) break
    const pos = progressToWorld(s, side * (CFG.roadHalfWidth + 36 + (i % 3) * 6), 4.5)
    fan.position.copy(pos)
    world.add(fan)
  }

  // signature floating ring + ball right at the start
  const startBall = makeFloatingBall()
  const startBallPos = progressToWorld(2, CFG.roadHalfWidth + 4, 4.4)
  startBall.position.copy(startBallPos)
  startBall.scale.setScalar(0.85)
  world.add(startBall)

  // floating balls along the route
  for (let i = 0; i < 12; i++) {
    const ball = makeFloatingBall()
    const side = i % 2 ? -1 : 1
    const s = 120 + i * 140
    if (s >= Track.length) break
    const pos = progressToWorld(s, side * (CFG.roadHalfWidth + 14 + rand(0, 8)), 11 + rand(0, 6))
    ball.position.copy(pos)
    world.add(ball)
  }

  // truss towers along the curve, both sides
  const towerCount = Math.floor(Track.length / 80)
  for (let i = 0; i < towerCount; i++) {
    const tower = makeTower(i)
    const side = i % 2 ? -1 : 1
    const s = 90 + i * 80
    if (s >= Track.length) break
    const pos = progressToWorld(s, side * (CFG.roadHalfWidth + 24 + (i % 3) * 6), 0)
    tower.position.copy(pos)
    world.add(tower)
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

  // glow underside (cyan light bar)
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 5),
    new THREE.MeshBasicMaterial({ color: 0x36e0ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending })
  )
  glow.rotation.x = -Math.PI / 2
  glow.position.y = 0.05
  player.add(glow)

  // nitro plume (hidden until active)
  const plumeMat = new THREE.MeshBasicMaterial({
    color: 0x2cc7ff,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending
  })
  nitroPlume = new THREE.Mesh(new THREE.ConeGeometry(0.55, 4.0, 14, 1, true), plumeMat)
  nitroPlume.rotation.x = Math.PI / 2
  nitroPlume.position.set(0, 0.6, 3.4)
  player.add(nitroPlume)
  const plume2 = nitroPlume.clone()
  plume2.material = plumeMat.clone()
  plume2.material.color.set(0xffe45a)
  plume2.scale.set(0.6, 1, 0.6)
  player.add(plume2)
  player.userData.plumes = [nitroPlume, plume2]

  // headlight
  headlight = new THREE.SpotLight(0xfff5d0, 0, 70, Math.PI / 5, 0.4, 1.0)
  headlight.position.set(0, 1.1, -1)
  headlight.target.position.set(0, 0.6, -8)
  player.add(headlight, headlight.target)

  player.position.set(0, state.y, state.z)
}

function makeFallbackCar(color, trim) {
  return makeHypercar({ body: color, accent: trim, wing: 0x111 })
}

// Rebuild player visual to match the currently-selected car (called on car
// switch). Existing player Group, glow, plumes, headlight stay intact.
function rebuildPlayerCar() {
  const carId = Save.get().selectedCar
  const cfg = CARS[carId] ?? CARS.sport
  // remove the old visual body if any
  if (playerBody) player.remove(playerBody)
  const car = cloneAsset(cfg.asset, 4.6, "z") || makeHypercar({ body: cfg.body })
  car.rotation.y = Math.PI
  recolorCar(car, { body: cfg.body, accent: cfg.accent })
  player.add(car)
  playerBody = car
  // apply stats to runtime CFG
  CFG.maxSpeed = cfg.maxSpeed
  CFG.nitroSpeed = cfg.nitroSpeed
  CFG.carAccel = cfg.accel
  CFG.carSteer = cfg.steerRate
}

// Apply the currently-selected track config: update length, finish, sky,
// fog. Track geometry will be rebuilt at race start.
function applyTrack() {
  const trackId = Save.get().selectedTrack
  const t = TRACKS[trackId] ?? TRACKS.sky
  CFG.trackLength = t.length
  CFG.finishZ = -(t.length - 50)
  CFG.rampGap = t.rampGap
  scene.background = new THREE.Color(t.sky)
  scene.fog = new THREE.Fog(t.fog[0], t.fog[1], t.fog[2])
}

// Koenigsegg-ish hypercar with sloped hood, bubble cabin, side scoops, big rear wing.
// Uses cell-shaded smooth surfaces instead of Kenney's blocky kit so the silhouette
// matches the screenshot's blue supercar.
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
  // 2 rivals on the start grid, just ahead of the player on the curve
  addRival({ lateral: -3.6, progress: 6, color: 0xee2424, accent: 0x4a0808, baseSpeed: 118 })
  addRival({ lateral: 3.6, progress: 6, color: 0xff5826, accent: 0x520f00, baseSpeed: 124 })
  // staggered rivals further down the track, spread across deterministic lanes
  const lanes = [-4.0, 4.0, -2.0, 2.0, 0]
  for (let i = 0; i < CFG.rivalCount; i++) {
    addRival({
      lateral: lanes[i % lanes.length],
      progress: 100 + i * 180,
      color: i % 2 ? 0xff3a3a : 0xff812a,
      accent: 0x3a0808,
      baseSpeed: 95 + i * 9 + rand(0, 12)
    })
  }
}

function addRival(cfg) {
  const assetName = (rivals.length % 2 === 0) ? "race" : "sedanSports"
  const car = cloneAsset(assetName, 4.4, "z") || makeHypercar({ body: cfg.color })
  car.rotation.y = Math.PI
  recolorCar(car, { body: cfg.color, accent: cfg.accent ?? 0x300404 })
  // place along curve at given progress
  const pos = progressToWorld(cfg.progress, cfg.lateral, 0.22)
  car.position.copy(pos)
  dynamic.add(car)
  rivals.push({
    car,
    baseSpeed: cfg.baseSpeed,
    progress: cfg.progress,
    lateral: cfg.lateral,
    laneTarget: cfg.lateral,
    swayPhase: Math.random() * tau,
    lastHit: -9999,
    bumpVx: 0
  })
}

function spawnPickups() {
  pickups.forEach((p) => dynamic.remove(p.mesh))
  pickups = []
  for (let s = 40; s < Track.length - 40; s += CFG.pickupGap) {
    const lane = Math.sin(s * 0.012) * 3.6
    const pattern = Math.floor(s / 100) % 4
    if (pattern === 3) continue
    if (pattern === 2) {
      const m = makeNitroPickup()
      placeAlongTrack(m, s, lane, 1.9 - 0.22)
      dynamic.add(m)
      pickups.push({ mesh: m, progress: s, lateral: lane, type: "nitro", taken: false })
    } else {
      for (const off of [-1.3, 0, 1.3]) {
        const m = makeCoin()
        const lat = clamp(lane + off, -CFG.playerHalfWidth, CFG.playerHalfWidth)
        const prog = s + off * 1.2
        placeAlongTrack(m, prog, lat, 2.0 - 0.22)
        dynamic.add(m)
        pickups.push({ mesh: m, progress: prog, lateral: lat, type: "coin", taken: false })
      }
    }
  }
  // hazard barriers
  for (let s = 300; s < Track.length - 30; s += 320) {
    const m = makeHazard()
    const lat = (Math.sin(s * 0.03) > 0 ? 1 : -1) * rand(2.8, 4.2)
    placeAlongTrack(m, s, lat, 0.6 - 0.22)
    dynamic.add(m)
    pickups.push({ mesh: m, progress: s, lateral: lat, type: "hazard", taken: false })
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

function makeHazard() {
  const ass = cloneAsset("barrierRed", 4.0)
  if (ass) {
    ass.rotation.y = Math.PI / 2
    return ass
  }
  return cloneAsset("cone", 1.6) || makeFallbackCar(0xff7a18, 0x222)
}

function spawnRamps() {
  ramps.forEach((r) => dynamic.remove(r.mesh))
  ramps = []
  // dramatic first ramp 30m ahead of the start so the player sees it immediately
  const m0 = makeRamp()
  placeAlongTrack(m0, 32, 0, 0.3 - 0.22)
  dynamic.add(m0)
  ramps.push({ mesh: m0, progress: 32, lateral: 0, used: false })
  for (let s = 180; s < Track.length - 90; s += CFG.rampGap + rand(-30, 30)) {
    const lat = Math.sin(s * 0.02) * 2.5
    const m = makeRamp()
    placeAlongTrack(m, s, lat, 0.3 - 0.22)
    dynamic.add(m)
    ramps.push({ mesh: m, progress: s, lateral: lat, used: false })
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
  for (let s = 200; s < Track.length - 80; s += CFG.checkpointGap) {
    const m = makeOverheadGantry(0x10c8ff, 0xfff15a, true)
    placeAlongTrack(m, s)
    dynamic.add(m)
    checkpoints.push({ mesh: m, progress: s, passed: false })
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

// Swipe-to-steer + double-tap nitro on the canvas itself, so phone players
// can drive without precise button taps. Buttons still work in parallel.
function bindCanvasGestures() {
  const canvas = $("game")
  let startX = 0
  let startY = 0
  let startTime = 0
  let lastTap = 0
  let active = false

  canvas.addEventListener("pointerdown", (e) => {
    if (state.mode !== "playing") return
    canvas.setPointerCapture?.(e.pointerId)
    startX = e.clientX
    startY = e.clientY
    startTime = performance.now()
    active = true
    // double-tap → nitro
    const now = performance.now()
    if (now - lastTap < 300) fireNitro()
    lastTap = now
  })

  canvas.addEventListener("pointermove", (e) => {
    if (!active || state.mode !== "playing") return
    e.preventDefault()
    const dx = e.clientX - startX
    // map horizontal drag distance to steer amount, normalised by viewport width
    const norm = clamp(dx / (innerWidth * 0.18), -1, 1)
    state.steer = norm
  })

  const release = (e) => {
    if (!active) return
    active = false
    canvas.releasePointerCapture?.(e.pointerId)
    state.steer = 0
    // very short tap on right half of screen → fire nitro
    const dt = performance.now() - startTime
    const dx = Math.abs(e.clientX - startX)
    const dy = Math.abs(e.clientY - startY)
    if (dt < 220 && dx < 12 && dy < 12 && e.clientX > innerWidth * 0.5) {
      // tap on right half acts as a gas pulse / nitro confirm; left half = brake pulse
      // (brake is already on the pedal, so nothing here)
    }
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
  $("splash").classList.toggle("active", mode === "boot")
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
  // tracks tile
  $("tracksTile").addEventListener("click", openTracks)
  $("trackCloseBtn").addEventListener("click", () => hideOverlay("trackScreen"))
  // daily tile
  $("dailyTile").addEventListener("click", () => maybeShowDailyBonus(true))
  $("dailyClaimBtn").addEventListener("click", () => {
    hideOverlay("dailyScreen")
    refreshCurrencyHud()
  })
  // privacy
  $("privacyAckBtn").addEventListener("click", () => {
    Save.setSettings({ privacyAck: true })
    hideOverlay("privacyScreen")
    setTimeout(() => maybeShowDailyBonus(), 250)
  })
  // share button
  $("shareBtn").addEventListener("click", shareResult)
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
  Object.values(CARS).forEach((c) => {
    const unlocked = save.unlockedCars.includes(c.id)
    const selected = save.selectedCar === c.id
    const card = document.createElement("div")
    card.className = `garage-card ${unlocked ? "" : "locked"} ${selected ? "selected" : ""}`
    const previewBg = `linear-gradient(135deg, #${c.body.toString(16).padStart(6, "0")}, #${c.accent.toString(16).padStart(6, "0")})`
    card.innerHTML = `
      <div class="preview" style="background:${previewBg}"></div>
      <b>${c.label}</b>
      <div class="stats">
        <div class="stat-bar"><b>极速</b><i style="--gap:${100 - c.maxSpeed / 2.6}%"></i></div>
        <div class="stat-bar"><b>加速</b><i style="--gap:${100 - c.accel * 30}%"></i></div>
        <div class="stat-bar"><b>操控</b><i style="--gap:${100 - c.steerRate * 9}%"></i></div>
      </div>
      ${unlocked ? "" : `<small>解锁: ${c.cost} 金币</small>`}
    `
    card.addEventListener("click", () => {
      if (unlocked) {
        Save.set({ selectedCar: c.id })
        openGarage()
      } else {
        const cur = Save.get()
        if (cur.coins >= c.cost) {
          Save.addCoins(-c.cost)
          Save.unlockCar(c.id)
          Save.set({ selectedCar: c.id })
          refreshCurrencyHud()
          openGarage()
        } else {
          toast(`金币不足 (${cur.coins}/${c.cost})`, 1200)
        }
      }
    })
    list.appendChild(card)
  })
  showOverlay("garageScreen")
}

function openTracks() {
  const list = $("trackList")
  list.innerHTML = ""
  const save = Save.get()
  Object.values(TRACKS).forEach((t) => {
    const unlocked = save.unlockedTracks.includes(t.id)
    const selected = save.selectedTrack === t.id
    const best = save.bestTimePerTrack[t.id]
    const card = document.createElement("div")
    card.className = `track-card ${unlocked ? "" : "locked"} ${selected ? "selected" : ""}`
    const previewBg = `linear-gradient(180deg, #${t.sky.toString(16).padStart(6, "0")}, #${t.fog[0].toString(16).padStart(6, "0")})`
    card.innerHTML = `
      <div class="preview" style="background:${previewBg}"></div>
      <b>${t.label}</b>
      <small style="color:#cfe0ff;font-size:calc(var(--ui)*0.85)">${t.desc}</small>
      ${best ? `<small style="color:#ffe35a">最佳: ${mmss(best.ms)}</small>` : ""}
      ${unlocked ? "" : `<small>解锁: ${t.cost} 金币</small>`}
    `
    card.addEventListener("click", () => {
      if (unlocked) {
        Save.set({ selectedTrack: t.id })
        openTracks()
      } else {
        const cur = Save.get()
        if (cur.coins >= t.cost) {
          Save.addCoins(-t.cost)
          Save.unlockTrack(t.id)
          Save.set({ selectedTrack: t.id })
          refreshCurrencyHud()
          openTracks()
        } else {
          toast(`金币不足 (${cur.coins}/${t.cost})`, 1200)
        }
      }
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
  if (renderer) renderer.setPixelRatio(dpr)
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
function shareResult() {
  try {
    const c = document.createElement("canvas")
    c.width = 720
    c.height = 480
    const g = c.getContext("2d")
    // backdrop
    const grd = g.createLinearGradient(0, 0, 0, 480)
    grd.addColorStop(0, "#0a1c3a")
    grd.addColorStop(1, "#1c4a99")
    g.fillStyle = grd
    g.fillRect(0, 0, 720, 480)
    // logo
    g.fillStyle = "#ffd31a"
    g.font = "bold 64px sans-serif"
    g.textAlign = "center"
    g.fillText("⚡ 闪电飞车", 360, 80)
    // result
    g.fillStyle = "#fff"
    g.font = "bold 38px sans-serif"
    g.fillText($("resultTitle").textContent, 360, 160)
    g.font = "bold 28px sans-serif"
    g.fillStyle = "#cfe0ff"
    g.fillText(`用时 ${$("resStatTime").textContent}`, 360, 240)
    g.fillText(`金币 ${$("resStatCoins").textContent}`, 360, 290)
    g.fillText(`碰撞 ${$("resStatHits").textContent}`, 360, 340)
    // footer
    g.font = "16px sans-serif"
    g.fillStyle = "#93a8c8"
    g.fillText("shandian-feiche.netlify.app", 360, 440)
    c.toBlob((blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `shandian-feiche-${Date.now()}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
      toast("成绩已保存到相册/下载", 1200)
    })
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
  // apply currently-selected car + track BEFORE resetting world
  rebuildPlayerCar()
  applyTrack()
  buildTrack()
  buildScenery()
  spawnPickups()
  spawnRamps()
  spawnCheckpoints()
  spawnRivals()

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
  state.startedAt = performance.now() + 3200  // race timer starts AFTER GO
  state.pauseAcc = 0
  state.finished = false
  state.finishedAt = 0
  state.lastRivalHit = 0
  state.airborne = false

  // reset world
  pickups.forEach((p) => {
    p.taken = false
    p.mesh.visible = true
  })
  ramps.forEach((r) => (r.used = false))
  checkpoints.forEach((c) => (c.passed = false))
  // reset rivals
  rivals.forEach((r, i) => {
    if (i < 2) {
      r.car.position.set(i === 0 ? -3.6 : 3.6, 0.22, 6)
      r.laneTarget = i === 0 ? -3.6 : 3.6
    } else {
      r.car.position.set(rand(-CFG.playerHalfWidth, CFG.playerHalfWidth), 0.22, -90 - i * 160)
    }
    r.bumpVx = 0
  })

  // place player on the curve at progress=0
  const startPos = progressToWorld(0, 0, state.y)
  player.position.copy(startPos)
  player.rotation.set(0, 0, 0)
  setMode("playing")
  runCountdown()
  maybeShowTutorial()
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
      step--
      state.countdown = step + 1
      setTimeout(tick, 900)
    } else {
      // GO!
      num.textContent = "GO!"
      num.classList.add("go")
      lights.forEach((l) => l.classList.add("go"))
      state.countdown = 0
      state.gas = 1
      state.shake = 0.35
      // GO sound: short pitch-up sweep
      if (audio.ctx) {
        const o = audio.ctx.createOscillator()
        const g = audio.ctx.createGain()
        o.type = "sawtooth"
        o.frequency.setValueAtTime(200, audio.ctx.currentTime)
        o.frequency.exponentialRampToValueAtTime(800, audio.ctx.currentTime + 0.3)
        g.gain.setValueAtTime(0.3, audio.ctx.currentTime)
        g.gain.exponentialRampToValueAtTime(0.001, audio.ctx.currentTime + 0.45)
        o.connect(g); g.connect(audio.master)
        o.start()
        o.stop(audio.ctx.currentTime + 0.5)
      }
      setTimeout(() => overlay.classList.remove("show"), 600)
    }
  }
  tick()
}

function pauseRace() {
  if (state.mode !== "playing") return
  state.pauseAt = performance.now()
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
  state.nitroTime = CFG.nitroDuration
  state.shake = 0.3
  toast("NITRO!", 900)
  sfxNitro()
}

function finishRace(success = true) {
  if (state.finished) return
  state.finished = true
  state.finishedAt = performance.now()
  setTimeout(() => {
    const ms = state.finishedAt - state.startedAt - state.pauseAcc
    const win = success && state.hits < CFG.hitLimit
    const save = Save.get()
    Save.recordRace({
      trackId: save.selectedTrack,
      carId: save.selectedCar,
      ms,
      coins: state.coins,
      hits: state.hits,
      success: win
    })
    $("resStatTime").textContent = mmss(ms)
    $("resStatCoins").textContent = String(state.coins)
    $("resStatHits").textContent = String(state.hits)
    $("resultTitle").textContent = win ? "闯关成功！" : "再试一次"
    $("resultCopy").textContent = win
      ? `用 ${mmss(ms)} 冲过终点，收集 ${state.coins} 枚金币。`
      : `碰撞太多 (${state.hits}/${CFG.hitLimit})，再来一局！`
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
        li.innerHTML = `<span>#${i + 1} · ${CARS[row.carId]?.label ?? row.carId}</span><b>${mmss(row.ms)}</b>`
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
  const dt = Math.min(0.033, (now - last) / 1000)
  last = now

  if (state.mode === "playing") {
    updateDriving(dt, now)
    updateRivals(dt, now)
    updatePickups(dt, now)
    updateRamps(dt, now)
    updateCheckpoints(now)
    updateCamera(dt)
    updateHUD()
  } else if (state.mode === "menu" || state.mode === "boot") {
    updateMenuCamera(now)
  } else if (state.mode === "paused" || state.mode === "result") {
    updateCamera(dt * 0.4)
  }

  // background world animation always active
  animateScenery(dt, now)
  updateParticles(dt)
  setEngineLoad(state.speed, state.nitroTime > 0)
  if (composer) composer.render()
  else renderer.render(scene, camera)
  requestAnimationFrame(loop)
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
    if (state.airborne) state.shake = Math.max(state.shake, 0.18)
    state.y = 0.22
    state.vy = 0
    state.airborne = false
  } else {
    state.airborne = true
  }

  // forward motion along the curve. speed (km/h) → m/s ≈ speed * 0.278.
  state.progress = clamp(state.progress + state.speed * dt * 0.278, 0, Track.length)

  // map track-space → world for the player car
  const worldPos = progressToWorld(state.progress, state.lateral, state.y)
  const tan = progressTangent(state.progress).clone()
  player.position.copy(worldPos)
  // orient player to face down the curve (forward = tangent), then add steer/jump tilt
  player.lookAt(worldPos.clone().add(tan))
  player.rotation.x += -state.vy * 0.012 + (state.airborne ? 0.05 : 0)
  player.rotation.z += -state.steerVisual * 0.18
  if (playerBody) {
    // face the car forward relative to the player group (Kenney models face -Z natively
    // and we rotate the parent player group so they need to flip 180°)
    playerBody.rotation.y = Math.PI - state.steerVisual * 0.05
  }

  // nitro plume
  const plumeOn = state.nitroTime > 0
  player.userData.plumes?.forEach((p, i) => {
    p.material.opacity = plumeOn ? lerp(p.material.opacity, i === 0 ? 0.85 : 0.6, 0.4) : lerp(p.material.opacity, 0, 0.2)
    p.scale.z = plumeOn ? 1 + Math.sin(now * 0.04) * 0.18 : 0.6
  })
  headlight.intensity = lerp(headlight.intensity, plumeOn ? 1.2 : 0.5, dt * 4)
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
      nitroTrail(back.x, back.y, back.z, Math.random() < 0.5 ? 0x36e0ff : 0xfff15a)
    }
  }

  // finish trigger — once we've covered the whole curve
  if (!state.finished && state.progress >= Track.length - 14) finishRace(true)
}

function updateRivals(dt, now) {
  for (const r of rivals) {
    // each rival drives at its own constant speed along the curve
    r.progress += r.baseSpeed * dt * 0.278
    // gap to player along the track (positive = rival ahead)
    const dProgress = r.progress - state.progress
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
    // lane sway + dodge if player close behind in same lane
    const playerCloseBehind = dProgress < 16 && dProgress > -2
    const playerAligned = Math.abs(r.lateral - state.lateral) < 1.4
    let lane = r.laneTarget + Math.sin(now * 0.0010 + r.swayPhase) * 1.4
    if (playerCloseBehind && playerAligned) {
      const dodge = state.lateral < 0 ? 2.4 : -2.4
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
      } else {
        state.hits++
        state.speed *= 0.65
        state.shake = 0.45
        toast("被撞了！稳住", 900)
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
    if (dProg < 3.6 && dLat < 2.0) {
      if (p.type === "coin") {
        p.taken = true
        p.mesh.visible = false
        state.coins++
        sparks(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, 0xffd23a, 10)
        sfxCoin()
      } else if (p.type === "nitro") {
        p.taken = true
        p.mesh.visible = false
        state.nitroCharges = Math.min(3, state.nitroCharges + 1)
        toast("氮气 +1", 800)
        sparks(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, 0xffe45a, 18)
        sfxCoin()
      } else if (p.type === "hazard" && state.nitroTime <= 0) {
        p.taken = true
        p.mesh.visible = false
        state.hits++
        state.speed *= 0.5
        state.shake = 0.5
        toast("撞到障碍！", 900)
        sparks(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, 0xff7a18, 24)
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
      const sparkPos = progressToWorld(r.progress, r.lateral, 1.0)
      sparks(sparkPos.x, sparkPos.y, sparkPos.z, 0xffd23a, 24)
      toast(state.nitroTime > 0 ? "超级飞跃！" : "飞跃！", 900)
      if (state.nitroCharges < 3) state.nitroCharges = Math.min(3, state.nitroCharges + 1)
    }
  }
}

function updateCheckpoints(now) {
  for (const c of checkpoints) {
    if (c.passed) continue
    if (state.progress > c.progress) {
      c.passed = true
      const pos = progressToWorld(c.progress, 0, 4.5)
      sparks(pos.x, pos.y, pos.z, 0x36e0ff, 28)
      toast("通过检查点！", 800)
      state.nitroCharges = Math.min(3, state.nitroCharges + 1)
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// camera
// ────────────────────────────────────────────────────────────────────
function updateCamera(dt) {
  const wide = innerWidth > innerHeight
  const back = wide ? 11 : 13
  const high = wide ? 4.6 : 5.4
  // sample the curve a few meters BEHIND the player for camera position,
  // and a few meters AHEAD for the look-at target. This makes the camera
  // bend naturally with the track in corners.
  const camProgress = clamp(state.progress - back, 0, Track.length)
  const lookProgress = clamp(state.progress + 22, 0, Track.length)
  const camWorld = progressToWorld(camProgress, state.lateral * 0.55 - state.steerVisual * 0.6, state.y + high)
  const lookWorld = progressToWorld(lookProgress, state.lateral * 0.4, state.y + 1.1)
  cameraTarget.copy(camWorld)
  if (state.shake > 0) {
    state.shake = Math.max(0, state.shake - dt)
    cameraTarget.x += (Math.random() - 0.5) * 0.4
    cameraTarget.y += (Math.random() - 0.5) * 0.25
  }
  camera.position.lerp(cameraTarget, dt * 6)
  cameraLook.copy(lookWorld)
  camera.lookAt(cameraLook)

  // FOV pulse driven by speed + nitro
  const baseFov = wide ? 60 : 70
  const speedRatio = clamp(state.speed / CFG.maxSpeed, 0, 1.4)
  const nitroBoost = state.nitroTime > 0 ? 8 : 0
  const targetFov = baseFov + speedRatio * 6 + nitroBoost
  camera.fov = lerp(camera.fov, targetFov, dt * 4)
  camera.updateProjectionMatrix()
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
function updateHUD() {
  $("speed").textContent = Math.round(state.speed)
  $("nitroCount").textContent = state.nitroCharges
  const progress = clamp(state.progress / Track.length, 0, 1)
  $("progressFill").style.height = `${Math.round(progress * 100)}%`
  $("missionFill").style.width = `${Math.round(progress * 100)}%`
  $("missionStats").textContent = `金币 ${state.coins}/${CFG.coinGoal} · 碰撞 ${state.hits}/${CFG.hitLimit}`
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

function resize() {
  camera.aspect = innerWidth / innerHeight
  camera.fov = innerWidth > innerHeight ? 60 : 70
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  if (composer) composer.setSize(innerWidth, innerHeight)
  if (bloomPass) bloomPass.setSize(innerWidth, innerHeight)
}

// register service worker (PWA offline cache)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  })
}

// init with friendly error UI on hard failure
init().catch((err) => {
  console.error("init failed", err)
  const status = document.getElementById("splashStatus")
  if (status) {
    status.style.color = "#ff8a8a"
    status.innerHTML = '加载失败 — <a href="javascript:location.reload()" style="color:#ffd31a;text-decoration:underline">点这里重试</a>'
  }
})
