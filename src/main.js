import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
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
  trackLength: 2300,
  segLength: 8,
  roadHalfWidth: 7.4,
  laneHalfWidth: 5.4,
  playerHalfWidth: 4.6,
  maxSpeed: 215,
  nitroSpeed: 305,
  nitroDuration: 2.4,
  finishZ: -2250,
  rivalCount: 5,
  pickupGap: 26,
  rampGap: 180,
  checkpointGap: 260,
  hitLimit: 10,
  coinGoal: 18
}

const state = {
  mode: "boot",
  speed: 0,
  z: 12,
  x: 0,
  y: 0.22,
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
  airSince: 0
}

let renderer, scene, camera
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
  renderer.toneMappingExposure = 1.2

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
  addEventListener("resize", resize)

  // splash → menu auto fade
  setTimeout(() => {
    $("splash").classList.add("fade-out")
    setTimeout(() => {
      $("splash").classList.remove("active", "fade-out")
      setMode("menu")
    }, 650)
  }, 1700)

  requestAnimationFrame(loop)
}

// ────────────────────────────────────────────────────────────────────
// materials & textures
// ────────────────────────────────────────────────────────────────────
function buildMaterials() {
  mats.roadCenter = new THREE.MeshStandardMaterial({
    map: roadCenterTexture(),
    roughness: 0.55,
    metalness: 0.05
  })
  mats.roadEdge = new THREE.MeshStandardMaterial({
    map: roadEdgeTexture(),
    roughness: 0.45,
    metalness: 0.08
  })
  mats.roadEdgeR = new THREE.MeshStandardMaterial({
    map: roadEdgeTexture(true),
    roughness: 0.45,
    metalness: 0.08
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
  c.width = c.height = 256
  const g = c.getContext("2d")
  g.fillStyle = "#ffd31a"
  g.fillRect(0, 0, 256, 256)
  // centre dashed lane stripes
  g.fillStyle = "#fff7c5"
  for (let i = 0; i < 256; i += 64) g.fillRect(120, i + 8, 16, 36)
  // subtle grid
  g.strokeStyle = "rgba(255,255,255,.18)"
  g.lineWidth = 1
  for (let i = 0; i < 256; i += 32) {
    g.beginPath()
    g.moveTo(i, 0)
    g.lineTo(i, 256)
    g.stroke()
  }
  // diagonal slant accent
  g.strokeStyle = "rgba(255,255,255,.22)"
  g.lineWidth = 4
  for (let i = -200; i < 320; i += 36) {
    g.beginPath()
    g.moveTo(i, 0)
    g.lineTo(i + 80, 256)
    g.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(1, 1)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function roadEdgeTexture(flip = false) {
  const c = document.createElement("canvas")
  c.width = c.height = 256
  const g = c.getContext("2d")
  g.fillStyle = "#ffd31a"
  g.fillRect(0, 0, 256, 256)
  g.save()
  if (flip) {
    g.translate(256, 0)
    g.scale(-1, 1)
  }
  // forward-pointing chevrons (V arrows) all aiming "up" the texture (the +V
  // direction), which maps to the player's forward direction when applied to
  // the road. Two-tone blue for depth.
  const stripeH = 28
  const stripeGap = 4
  const tip = 0      // x position of the chevron tip on the inner edge (texture left)
  const tail = 256   // x position of the chevron tail on the outer edge (texture right)
  const tipDepth = 10 // chevron tip pulled forward (smaller V)
  for (let y = -stripeH; y < 256 + stripeH; y += stripeH + stripeGap) {
    g.fillStyle = "#0c5fb6"
    g.beginPath()
    g.moveTo(tip, y + stripeH / 2)
    g.lineTo(tail, y)
    g.lineTo(tail, y + 6)
    g.lineTo(tip + tipDepth, y + stripeH / 2)
    g.lineTo(tail, y + stripeH - 6)
    g.lineTo(tail, y + stripeH)
    g.closePath()
    g.fill()
    // bright blue inner highlight chevron
    g.fillStyle = "#1392ff"
    g.beginPath()
    g.moveTo(tip + 4, y + stripeH / 2)
    g.lineTo(tail - 8, y + 6)
    g.lineTo(tail - 8, y + 10)
    g.lineTo(tip + 14, y + stripeH / 2)
    g.lineTo(tail - 8, y + stripeH - 10)
    g.lineTo(tail - 8, y + stripeH - 6)
    g.closePath()
    g.fill()
  }
  // yellow seam strip on the inner edge (next to centre lane)
  g.fillStyle = "#ffd31a"
  g.fillRect(0, 0, 12, 256)
  g.restore()
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
  const list = await Promise.all(Object.entries(items).map(async ([k, url]) => {
    try {
      const g = await loader.loadAsync(url)
      return [k, g.scene]
    } catch (e) {
      console.warn("asset missing", url, e)
      return [k, null]
    }
  }))
  assets = Object.fromEntries(list)
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
function buildTrack() {
  track.clear()

  const segCount = Math.ceil(CFG.trackLength / CFG.segLength)
  const lengthMeters = segCount * CFG.segLength

  // road shape
  const centerGeo = new THREE.BoxGeometry(CFG.laneHalfWidth * 2, 0.36, lengthMeters)
  const centerMesh = new THREE.Mesh(centerGeo, mats.roadCenter)
  centerMesh.position.set(0, 0, -lengthMeters / 2 + 18)
  centerMesh.material.map.repeat.set(1, lengthMeters / 24)
  track.add(centerMesh)

  const edgeWidth = CFG.roadHalfWidth - CFG.laneHalfWidth
  for (const side of [-1, 1]) {
    const geo = new THREE.BoxGeometry(edgeWidth, 0.36, lengthMeters)
    // LEFT strip uses flipped texture (tip → inward at u=1), RIGHT uses native texture (tip → inward at u=0)
    const mesh = new THREE.Mesh(geo, side < 0 ? mats.roadEdgeR : mats.roadEdge)
    mesh.material.map.repeat.set(1, lengthMeters / 16)
    mesh.position.set(side * (CFG.laneHalfWidth + edgeWidth / 2), 0, -lengthMeters / 2 + 18)
    track.add(mesh)
  }

  // rails (blue lower + yellow top accent)
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.95, lengthMeters), mats.rail)
    rail.position.set(side * (CFG.roadHalfWidth + 0.21), 0.65, -lengthMeters / 2 + 18)
    track.add(rail)
    const railTop = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.18, lengthMeters), mats.railTop)
    railTop.position.set(side * (CFG.roadHalfWidth + 0.21), 1.18, -lengthMeters / 2 + 18)
    track.add(railTop)
  }

  // structural underside ribs (every 24m), gives the "sky bridge" feel
  const ribCount = Math.floor(lengthMeters / 24)
  const ribGeo = new THREE.BoxGeometry(CFG.roadHalfWidth * 2 + 1.6, 1.4, 1.4)
  for (let i = 0; i < ribCount; i++) {
    const z = 16 - i * 24
    const rib = new THREE.Mesh(ribGeo, mats.support)
    rib.position.set(0, -0.9, z)
    track.add(rib)
    // diagonal struts
    for (const s of [-1, 1]) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 8), mats.support)
      strut.position.set(s * (CFG.roadHalfWidth + 0.2), -2.4, z - 2)
      strut.rotation.x = -0.6
      track.add(strut)
    }
  }

  // periodic blue zebra stripes across the centre lane
  const zebraMat = new THREE.MeshStandardMaterial({ color: 0x1392ff, roughness: 0.4 })
  for (let z = -4; z > -lengthMeters; z -= 64) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(CFG.laneHalfWidth * 2 - 0.4, 0.05, 1.2), zebraMat)
    stripe.position.set(0, 0.21, z)
    track.add(stripe)
  }

  // start gantry behind player at z = 22
  const startGantry = makeOverheadGantry(0xfff15a, 0xffce15, true)
  startGantry.position.set(0, 0, 22)
  track.add(startGantry)

  // welcome arch 18m ahead of the start grid (mimics screenshot 3 — there's a
  // big horizontal banner just past the cars at race start)
  const welcomeArch = makeOverheadGantry(0x10c8ff, 0xfff15a, false)
  welcomeArch.position.set(0, 0, -16)
  track.add(welcomeArch)

  // start grid markings (zebra stripe)
  const startStripe = new THREE.Mesh(new THREE.PlaneGeometry(CFG.laneHalfWidth * 2, 4), mats.checker)
  startStripe.rotation.x = -Math.PI / 2
  startStripe.position.set(0, 0.2, 14)
  track.add(startStripe)

  // finish line
  const finish = makeFinishLine()
  finish.position.set(0, 0, CFG.finishZ)
  track.add(finish)
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
  // ground far below the road (so the track feels suspended in the sky)
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2200, 2200),
    new THREE.MeshStandardMaterial({ color: 0x4d8bc4, roughness: 0.95 })
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.set(0, -60, -700)
  world.add(ground)

  // wind-turbine like fans — these are the big yellow "circles" in the screenshots
  for (let i = 0; i < 14; i++) {
    const fan = makeTurbine(i)
    const side = i % 2 ? -1 : 1
    fan.position.set(side * (38 + (i % 3) * 6), 4.5, -60 - i * 90)
    world.add(fan)
  }

  // signature floating ring + ball right at the start, on the right side, just
  // like screenshot 3 — first thing the player sees
  const startBall = makeFloatingBall()
  startBall.position.set(7, 4.4, -2)
  startBall.scale.setScalar(0.85)
  world.add(startBall)

  // floating soccer-style spheres along the route
  for (let i = 0; i < 10; i++) {
    const ball = makeFloatingBall()
    const side = i % 2 ? -1 : 1
    ball.position.set(side * (22 + rand(0, 10)), 11 + rand(0, 6), -120 - i * 120)
    world.add(ball)
  }

  // tower stacks
  for (let i = 0; i < 14; i++) {
    const tower = makeTower(i)
    const side = i % 2 ? -1 : 1
    tower.position.set(side * (50 + (i % 3) * 6), 0, -90 - i * 75)
    world.add(tower)
  }

  // grandstand at start
  const stand = cloneAsset("grandStand", 22, "z")
  if (stand) {
    stand.position.set(-50, -8, -10)
    stand.rotation.y = Math.PI / 2
    world.add(stand)
    const stand2 = stand.clone(true)
    stand2.position.set(50, -8, -10)
    stand2.rotation.y = -Math.PI / 2
    world.add(stand2)
  }

  // a few trees
  for (let i = 0; i < 12; i++) {
    const tree = cloneAsset("treeLarge", 5)
    if (!tree) break
    const side = i % 2 ? -1 : 1
    tree.position.set(side * (16 + rand(0, 6)), -2, -40 - i * 110)
    world.add(tree)
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

function makeTower(seed) {
  const g = new THREE.Group()
  for (let i = 0; i < 3 + (seed % 3); i++) {
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(4 + (i % 2) * 1.5, 4, 4),
      new THREE.MeshStandardMaterial({ color: i % 2 ? 0xffd02e : 0x1da3ec, roughness: 0.35 })
    )
    block.position.set(0, 2 + i * 4, 0)
    g.add(block)
  }
  return g
}

// ────────────────────────────────────────────────────────────────────
// player car — Kenney CC0 race car, deeply tinted bright blue
// ────────────────────────────────────────────────────────────────────
function buildPlayer() {
  player = new THREE.Group()
  scene.add(player)

  const car = cloneAsset("raceFuture", 4.6, "z") || cloneAsset("sedanSports", 4.6, "z") || makeHypercar({ body: 0x16a8ff })
  car.rotation.y = Math.PI
  recolorCar(car, { body: 0x18b6ff, accent: 0x05213d })
  playerBody = car
  player.add(car)

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
  // 2 rivals on the start grid, just ahead and to each side (mimic screenshot 3 + 4)
  const startConfigs = [
    { x: -3.6, z: 6, color: 0xee2424, accent: 0x4a0808, baseSpeed: 118 },
    { x: 3.6, z: 6, color: 0xff5826, accent: 0x520f00, baseSpeed: 124 }
  ]
  for (const cfg of startConfigs) addRival(cfg)
  // staggered rivals further down, spread across deterministic lanes so they
  // don't all sit in the player's centre lane
  const lanes = [-4.0, 4.0, -2.0, 2.0, 0]
  for (let i = 0; i < CFG.rivalCount; i++) {
    addRival({
      x: lanes[i % lanes.length],
      z: -100 - i * 180,
      color: i % 2 ? 0xff3a3a : 0xff812a,
      accent: 0x3a0808,
      baseSpeed: 95 + i * 9 + rand(0, 12)
    })
  }
}

function addRival(cfg) {
  // alternate Kenney models so rivals don't look identical
  const assetName = (rivals.length % 2 === 0) ? "race" : "sedanSports"
  const car = cloneAsset(assetName, 4.4, "z") || makeHypercar({ body: cfg.color })
  car.rotation.y = Math.PI
  recolorCar(car, { body: cfg.color, accent: cfg.accent ?? 0x300404 })
  car.position.set(cfg.x, 0.22, cfg.z)
  dynamic.add(car)
  rivals.push({
    car,
    baseSpeed: cfg.baseSpeed,
    laneTarget: cfg.x,
    swayPhase: Math.random() * tau,
    lastHit: -9999,
    bumpVx: 0
  })
}

function spawnPickups() {
  pickups.forEach((p) => dynamic.remove(p.mesh))
  pickups = []
  for (let z = -40; z > CFG.finishZ + 40; z -= CFG.pickupGap) {
    // a coin row pattern
    const lane = Math.sin(z * 0.012) * 3.6
    const pattern = Math.floor(Math.abs(z) / 100) % 4
    if (pattern === 3) {
      // skip = nothing here (creates rhythm)
      continue
    }
    if (pattern === 2) {
      // nitro can
      const m = makeNitroPickup()
      m.position.set(lane, 1.9, z)
      dynamic.add(m)
      pickups.push({ mesh: m, x: lane, z, type: "nitro", taken: false })
    } else {
      // coin trio
      for (const off of [-1.3, 0, 1.3]) {
        const m = makeCoin()
        m.position.set(clamp(lane + off, -CFG.playerHalfWidth, CFG.playerHalfWidth), 2.0, z + off * 1.2)
        dynamic.add(m)
        pickups.push({ mesh: m, x: m.position.x, z: m.position.z, type: "coin", taken: false })
      }
    }
  }
  // some hazard barriers
  for (let z = -300; z > CFG.finishZ; z -= 320) {
    const m = makeHazard()
    const x = (Math.sin(z * 0.03) > 0 ? 1 : -1) * rand(2.8, 4.2)
    m.position.set(x, 0.6, z)
    dynamic.add(m)
    pickups.push({ mesh: m, x, z, type: "hazard", taken: false })
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
  const firstZ = -32
  const m0 = makeRamp()
  m0.position.set(0, 0.3, firstZ)
  dynamic.add(m0)
  ramps.push({ mesh: m0, x: 0, z: firstZ, used: false })
  for (let z = -180; z > CFG.finishZ + 90; z -= CFG.rampGap + rand(-30, 30)) {
    const x = Math.sin(z * 0.02) * 2.5
    const m = makeRamp()
    m.position.set(x, 0.3, z)
    dynamic.add(m)
    ramps.push({ mesh: m, x, z, used: false })
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
  for (let z = -200; z > CFG.finishZ + 80; z -= CFG.checkpointGap) {
    const m = makeOverheadGantry(0x10c8ff, 0xfff15a, true)
    m.position.set(0, 0, z)
    dynamic.add(m)
    checkpoints.push({ mesh: m, z, passed: false })
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
}

function startRace() {
  // reset run state
  state.speed = 0
  state.x = 0
  state.y = 0.22
  state.vy = 0
  state.z = 12
  state.steer = 0
  state.gas = 1
  state.brake = 0
  state.nitroCharges = 1
  state.nitroTime = 0
  state.coins = 0
  state.hits = 0
  state.shake = 0
  state.startedAt = performance.now()
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

  player.position.set(0, state.y, state.z)
  player.rotation.set(0, 0, 0)
  setMode("playing")
  toast("准备... 出发！", 1200)
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
}

function finishRace(success = true) {
  if (state.finished) return
  state.finished = true
  state.finishedAt = performance.now()
  setTimeout(() => {
    const ms = state.finishedAt - state.startedAt - state.pauseAcc
    $("resStatTime").textContent = mmss(ms)
    $("resStatCoins").textContent = String(state.coins)
    $("resStatHits").textContent = String(state.hits)
    const win = success && state.hits < CFG.hitLimit
    $("resultTitle").textContent = win ? "闯关成功！" : "再试一次"
    $("resultCopy").textContent = win
      ? `用 ${mmss(ms)} 冲过终点，收集 ${state.coins} 枚金币。`
      : `碰撞太多 (${state.hits}/${CFG.hitLimit})，再来一局！`
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
  renderer.render(scene, camera)
  requestAnimationFrame(loop)
}

function updateDriving(dt, now) {
  // throttle / brake
  if (!state.finished) {
    const target = state.brake ? 0 : (state.nitroTime > 0 ? CFG.nitroSpeed : (state.gas ? CFG.maxSpeed : 95))
    const accel = state.gas ? 2.0 : 0.8
    state.speed = lerp(state.speed, target, dt * accel)
    if (state.brake) state.speed = Math.max(0, state.speed - 200 * dt)
  } else {
    state.speed = lerp(state.speed, 35, dt * 1.2)
  }
  if (state.nitroTime > 0) state.nitroTime = Math.max(0, state.nitroTime - dt)

  // steering — visual lean + lateral velocity
  state.steerVisual = lerp(state.steerVisual, state.steer, dt * 6)
  const steerStrength = 6.5 + state.speed * 0.05
  state.x = clamp(state.x + state.steer * dt * steerStrength, -CFG.playerHalfWidth, CFG.playerHalfWidth)

  // gravity / jump
  state.vy -= 32 * dt
  state.y += state.vy * dt
  if (state.y < 0.22) {
    if (state.airborne) {
      // landed — give a small boost feeling
      state.shake = Math.max(state.shake, 0.18)
    }
    state.y = 0.22
    state.vy = 0
    state.airborne = false
  } else {
    state.airborne = true
  }

  // forward motion
  state.z -= state.speed * dt * 0.22

  // apply to player
  player.position.set(state.x, state.y, state.z)
  player.rotation.set(
    -state.vy * 0.012 + (state.airborne ? 0.05 : 0),
    state.steerVisual * 0.16,
    -state.steerVisual * 0.18
  )
  if (playerBody) {
    playerBody.rotation.y = Math.PI - state.steerVisual * 0.05
  }

  // nitro plume
  const plumeOn = state.nitroTime > 0
  player.userData.plumes?.forEach((p, i) => {
    p.material.opacity = plumeOn ? lerp(p.material.opacity, i === 0 ? 0.85 : 0.6, 0.4) : lerp(p.material.opacity, 0, 0.2)
    p.scale.z = plumeOn ? 1 + Math.sin(now * 0.04) * 0.18 : 0.6
  })
  headlight.intensity = lerp(headlight.intensity, plumeOn ? 1.2 : 0.5, dt * 4)
  // nitro particle trail (spawn at the rear of the player while active)
  if (plumeOn) {
    state._nitroEmitTimer = (state._nitroEmitTimer || 0) - dt
    if (state._nitroEmitTimer <= 0) {
      state._nitroEmitTimer = 0.018
      const sx = (Math.random() - 0.5) * 1.2
      const sy = 0.55 + Math.random() * 0.2
      nitroTrail(state.x + sx, state.y + sy, state.z + 3.4, Math.random() < 0.5 ? 0x36e0ff : 0xfff15a)
    }
  }

  // finish trigger
  if (!state.finished && state.z < CFG.finishZ + 14) finishRace(true)
}

function updateRivals(dt, now) {
  for (const r of rivals) {
    const car = r.car
    const dz = car.position.z - state.z
    // each rival drives at its own constant speed (no chasing the player) — feels
    // like real opponents rather than rubber-banding
    car.position.z -= r.baseSpeed * dt * 0.22
    // far behind player → respawn comfortably ahead
    if (dz > 60) {
      car.position.z = state.z - 90 - rand(0, 80)
      // respawn into a lane offset from the player's current x (avoid head-on)
      const lanes = [-4, -2, 2, 4]
      car.position.x = lanes[Math.floor(Math.random() * lanes.length)]
      r.laneTarget = car.position.x
      r.lastHit = now      // grace period after teleport so respawn doesn't insta-collide
    }
    // way ahead of player → bring them back into view so the field stays exciting
    if (dz < -360) {
      car.position.z = state.z - 90 - rand(0, 80)
      // respawn into a lane offset from the player's current x (avoid head-on)
      const lanes = [-4, -2, 2, 4]
      car.position.x = lanes[Math.floor(Math.random() * lanes.length)]
      r.laneTarget = car.position.x
    }
    // sway lane gently around the rival's preferred lane.
    // when player is close behind and aligned, rival shifts AWAY (yield).
    const playerCloseBehind = (car.position.z - state.z) < 16 && (car.position.z - state.z) > -2
    const playerAligned = Math.abs(car.position.x - state.x) < 1.4
    let lane = r.laneTarget + Math.sin(now * 0.0010 + r.swayPhase) * 1.4
    if (playerCloseBehind && playerAligned) {
      const dodge = state.x < 0 ? 2.4 : -2.4
      lane = clamp(r.laneTarget + dodge, -CFG.playerHalfWidth, CFG.playerHalfWidth)
    }
    car.position.x = lerp(car.position.x, lane, dt * 1.6)
    car.position.x += r.bumpVx * dt
    r.bumpVx *= Math.pow(0.05, dt)
    car.position.x = clamp(car.position.x, -CFG.playerHalfWidth, CFG.playerHalfWidth)
    car.position.y = 0.22

    // car bob & subtle steer lean
    const lean = Math.sin(now * 0.003 + r.swayPhase) * 0.05 + (r.car.position.x - state.x) * 0.02
    car.rotation.set(0, Math.PI - lean * 0.6, lean * 0.8)
    // collision with player
    if (state.finished) continue
    const distZ = Math.abs(car.position.z - state.z)
    const distX = Math.abs(car.position.x - state.x)
    const sinceStart = now - state.startedAt - state.pauseAcc
    if (sinceStart < 1500) continue   // 1.5s start-grid grace period
    if (distZ < 2.6 && distX < 1.4 && now - r.lastHit > 1500 && now - state.lastRivalHit > 900) {
      r.lastHit = now
      state.lastRivalHit = now
      const dir = state.x < car.position.x ? -1 : 1
      r.bumpVx = dir * 14
      state.x = clamp(state.x - dir * 0.7, -CFG.playerHalfWidth, CFG.playerHalfWidth)
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
      sparks((state.x + car.position.x) / 2, 1.6, (state.z + car.position.z) / 2, 0xffe45a, 22)
    }
  }
}

function updatePickups(dt, now) {
  for (const p of pickups) {
    if (p.taken) continue
    if (p.type !== "hazard") {
      p.mesh.rotation.y += dt * 4
      p.mesh.position.y = (p.type === "nitro" ? 1.9 : 2.0) + Math.sin(now * 0.004 + p.z) * 0.2
    }
    if (Math.abs(p.z - state.z) < 3.6 && Math.abs(p.x - state.x) < 2.0) {
      if (p.type === "coin") {
        p.taken = true
        p.mesh.visible = false
        state.coins++
        sparks(p.x, 2.0, p.z, 0xffd23a, 10)
      } else if (p.type === "nitro") {
        p.taken = true
        p.mesh.visible = false
        state.nitroCharges = Math.min(3, state.nitroCharges + 1)
        toast("氮气 +1", 800)
        sparks(p.x, 2.0, p.z, 0xffe45a, 18)
      } else if (p.type === "hazard" && state.nitroTime <= 0) {
        p.taken = true
        p.mesh.visible = false
        state.hits++
        state.speed *= 0.5
        state.shake = 0.5
        toast("撞到障碍！", 900)
        sparks(p.x, 1.2, p.z, 0xff7a18, 24)
        if (state.hits >= CFG.hitLimit) finishRace(false)
      }
    }
  }
}

function updateRamps(dt, now) {
  for (const r of ramps) {
    r.mesh.rotation.y = 0
    if (r.used) continue
    if (Math.abs(r.z - state.z) < 4.6 && Math.abs(r.x - state.x) < 3.0 && state.y <= 0.4) {
      r.used = true
      const power = state.nitroTime > 0 ? 22 : 17
      state.vy = power
      state.airborne = true
      state.shake = 0.32
      sparks(r.x, 1.0, r.z, 0xffd23a, 24)
      toast(state.nitroTime > 0 ? "超级飞跃！" : "飞跃！", 900)
      // small re-charge
      if (state.nitroCharges < 3) state.nitroCharges = Math.min(3, state.nitroCharges + 1)
    }
  }
}

function updateCheckpoints(now) {
  for (const c of checkpoints) {
    if (c.passed) continue
    if (state.z < c.z) {
      c.passed = true
      sparks(0, 4.5, c.z, 0x36e0ff, 28)
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
  cameraTarget.set(state.x * 0.55, state.y + high, state.z + back)
  if (state.shake > 0) {
    state.shake = Math.max(0, state.shake - dt)
    cameraTarget.x += (Math.random() - 0.5) * 0.4
    cameraTarget.y += (Math.random() - 0.5) * 0.25
  }
  camera.position.lerp(cameraTarget, dt * 6)
  cameraLook.set(state.x * 0.4, state.y + 1.1, state.z - 22)
  camera.lookAt(cameraLook)
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
  const progress = clamp((-state.z) / Math.abs(CFG.finishZ), 0, 1)
  $("progressFill").style.height = `${Math.round(progress * 100)}%`
  $("missionFill").style.width = `${Math.round(progress * 100)}%`
  $("missionStats").textContent = `金币 ${state.coins}/${CFG.coinGoal} · 碰撞 ${state.hits}/${CFG.hitLimit}`
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
}

init()
