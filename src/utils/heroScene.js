// V1.9.0: cinematic hero scene for the home page.
//
// What changed from V1.8.9:
//   • Camera is no longer fixed; it ORBITS the car on a cinematic path
//     with stop-pan-stop pacing (60% time looking, 40% time panning).
//     Pitch ≈ 45° low-angle commercial framing — was a static 30°.
//   • Three-point lighting (key + fill + rim) replaces the original
//     single-key-plus-rim setup. Fill light fights the ACES tonemap's
//     shadow crush; rim outlines the silhouette against the dark stage.
//   • Stage disc gets a soft radial glow + circular gradient texture so
//     the car "rests on something" instead of clipping into the modal.
//   • A second wider, fainter ambient ring sits behind the car (back-
//     light spill) to suggest a showroom background light.
//   • Car body materials are detected and re-tuned per role:
//        body panel  → high metalness, low roughness, +clearcoat
//        glass       → transparent + IOR ~1.5 + low roughness
//        rims/tires  → kept matte
//   • A 220ms entry animation scales the car from 0.92 → 1.0 and fades
//     the renderer's clearAlpha from 0 → 1 the first time the page loads.
//
// What is unchanged (red-line invariants):
//   • Same GLB asset (race-future) — no model swap.
//   • Independent THREE.Scene / Camera / WebGLRenderer — does not touch
//     the main game's renderer / camera / spline / V1.8.7 chase logic.
//   • RAF gating from setMode("menu") | setMode(other) is intact.
//   • document.visibilityState === "hidden" also halts RAF.

import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"

const STATE = {
  mount: null,
  canvas: null,
  renderer: null,
  scene: null,
  camera: null,
  carRoot: null,
  ro: null,
  rafId: 0,
  lastTime: 0,
  running: false,
  glbCache: new Map(),
  _pendingCarId: null,
  // V1.9.0 camera + entry-animation state.
  camAngle: 0,           // current orbit angle (rad), 0 = front-right
  camLastUpdate: 0,
  entryStart: 0,         // performance.now() when this scene first showed
  entryDone: false,
  // visibilitychange handler (kept on STATE so we can detach in stop()).
  _visHandler: null,
}

// Camera orbit path (V1.9.0):
//   – 3 hand-picked angle stops, with a 1.25 s dwell + 1.25 s pan
//     each. Total cycle 7.5 s — within a typical home-page glance.
//   – Pitch is fixed at ~33° below "behind the car" — that puts the
//     virtual camera at car-grille height (45° low-angle commercial
//     framing reads as "looking up at a hero car").
const CAMERA_RADIUS = 9.4
const CAMERA_HEIGHT = 3.4   // metres above ground; car is ~1.5m tall, so we look up at it
const CAMERA_LOOK_AT = new THREE.Vector3(0, 1.0, 0)
// V1.9.4-3: condensed to 3 stops with a tighter cycle so users who
// only stay on the home for 5–10 s still see a full rotation instead
// of catching one hold-and-pan.
const STOP_ANGLES = [
  Math.PI * 0.25,
  Math.PI * 0.85,
  Math.PI * 1.45,
]
const DWELL_S = 1.25
const PAN_S = 1.25
const CYCLE_S = (DWELL_S + PAN_S) * STOP_ANGLES.length

// V1.9.4-3: per-mode camera + car tuning. Read at runtime in
// updateHeroLayout() so resize / orientationchange re-applies it.
const HERO_LAYOUT = {
  "mobile-full": {
    fov: 28,
    carScale: 0.78,
    carPos: { x: 0.32, y: -0.42, z: 0 },
  },
  "default": {
    fov: 35,
    carScale: 1.0,
    carPos: { x: 0, y: 0, z: 0 },
  },
}

function ensureRendererForMount(mount) {
  if (STATE.renderer) return
  const w = Math.max(1, mount.clientWidth)
  const h = Math.max(1, mount.clientHeight)
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setSize(w, h, false)
  renderer.setClearColor(0x000000, 0)
  const canvas = renderer.domElement
  canvas.style.width = "100%"
  canvas.style.height = "100%"
  canvas.style.display = "block"
  canvas.style.pointerEvents = "none"
  mount.appendChild(canvas)

  const scene = new THREE.Scene()
  scene.background = null
  // PMREM-prefiltered RoomEnvironment so the body panels reflect a
  // soft studio cube map (clearcoat reads as "deep paint", not flat).
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  pmrem.dispose()

  const camera = new THREE.PerspectiveCamera(26, w / h, 0.1, 100)
  STATE.renderer = renderer
  STATE.canvas = canvas
  STATE.scene = scene
  STATE.camera = camera

  // ── V1.9.0 three-point lighting ──
  // Ambient is intentionally low — let the env map carry the soft fill.
  scene.add(new THREE.AmbientLight(0xffffff, 0.18))
  // KEY: warm directional, camera-right-up, primary highlight side.
  const key = new THREE.DirectionalLight(0xfff2c8, 1.6)
  key.position.set(7, 10, 6)
  scene.add(key)
  // FILL: cool, opposite the key, fights ACES shadow crush on the dark side.
  const fill = new THREE.DirectionalLight(0xa6c8ff, 0.7)
  fill.position.set(-6, 4, 5)
  scene.add(fill)
  // RIM: behind the car at low height, accents the silhouette in cyan.
  const rim = new THREE.DirectionalLight(0x66e0ff, 1.1)
  rim.position.set(-1, 2.4, -8)
  scene.add(rim)
  // Subtle warm spill from below to keep the underside readable.
  const underFill = new THREE.HemisphereLight(0xfff0c8, 0.0, 0.18)
  scene.add(underFill)

  // ── Stage disc (V1.9.0) ──
  // Larger radius, radial soft-edge texture so it fades into the page
  // background instead of having a hard circle outline.
  const stageGeo = new THREE.CircleGeometry(4.6, 96)
  const stageMat = new THREE.MeshBasicMaterial({
    map: makeStageDiscTexture(),
    transparent: true,
    depthWrite: false,
    color: 0xffffff,
  })
  const stage = new THREE.Mesh(stageGeo, stageMat)
  stage.rotation.x = -Math.PI / 2
  stage.position.y = 0.001
  scene.add(stage)
  // A second smaller bright disc at the dead centre — fakes a spotlight
  // hitting the ground beneath the car.
  const spotGeo = new THREE.CircleGeometry(2.0, 64)
  const spotMat = new THREE.MeshBasicMaterial({
    map: makeStageSpotTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const spot = new THREE.Mesh(spotGeo, spotMat)
  spot.rotation.x = -Math.PI / 2
  spot.position.y = 0.005
  scene.add(spot)
  // Behind-car soft glow: a vertical plane that reads as a faint
  // backlit haze. Ambient-occlusion-style soft halo.
  const hazeGeo = new THREE.PlaneGeometry(8, 5)
  const hazeMat = new THREE.MeshBasicMaterial({
    map: makeBackHazeTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.55,
  })
  const haze = new THREE.Mesh(hazeGeo, hazeMat)
  haze.position.set(0, 1.6, -2.5)
  scene.add(haze)

  // Initial camera placement (will be overwritten by first tick, but
  // setting it here avoids a one-frame flash from origin).
  setCameraFromAngle(STOP_ANGLES[0])

  STATE.ro = new ResizeObserver(() => {
    if (!STATE.renderer || !STATE.mount) return
    const cw = Math.max(1, STATE.mount.clientWidth)
    const ch = Math.max(1, STATE.mount.clientHeight)
    STATE.renderer.setSize(cw, ch, false)
    STATE.camera.aspect = cw / ch
    STATE.camera.updateProjectionMatrix()
  })
  STATE.ro.observe(mount)

  // V1.9.0: stop RAF when the tab becomes hidden so we don't burn GPU
  // when the user alt-tabs to another window.
  STATE._visHandler = () => {
    if (document.visibilityState === "hidden") {
      stopHeroScene({ keepFlag: true })
    } else if (STATE.running) {
      // already running but RAF was paused — kick it.
      STATE.lastTime = 0
      STATE.rafId = requestAnimationFrame(tick)
    }
  }
  document.addEventListener("visibilitychange", STATE._visHandler)
}

// Procedural radial-falloff texture for the stage disc — bright in the
// middle, soft fade to transparent at the rim.
function makeStageDiscTexture() {
  const c = document.createElement("canvas")
  c.width = c.height = 256
  const ctx = c.getContext("2d")
  const g = ctx.createRadialGradient(128, 128, 30, 128, 128, 128)
  g.addColorStop(0, "rgba(40, 60, 110, 0.85)")
  g.addColorStop(0.55, "rgba(20, 30, 70, 0.45)")
  g.addColorStop(1, "rgba(0, 0, 0, 0)")
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
// Tighter additive spot at the centre — reads as a key-light hitting
// the floor in front of the car.
function makeStageSpotTexture() {
  const c = document.createElement("canvas")
  c.width = c.height = 256
  const ctx = c.getContext("2d")
  const g = ctx.createRadialGradient(128, 128, 6, 128, 128, 128)
  g.addColorStop(0, "rgba(120, 200, 255, 0.85)")
  g.addColorStop(0.4, "rgba(38, 130, 220, 0.30)")
  g.addColorStop(1, "rgba(0, 0, 0, 0)")
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
// Vertical background haze: a soft elliptical gradient.
function makeBackHazeTexture() {
  const c = document.createElement("canvas")
  c.width = 512
  c.height = 256
  const ctx = c.getContext("2d")
  const g = ctx.createRadialGradient(256, 128, 40, 256, 128, 250)
  g.addColorStop(0, "rgba(120, 180, 255, 0.65)")
  g.addColorStop(0.5, "rgba(50, 80, 200, 0.18)")
  g.addColorStop(1, "rgba(0, 0, 0, 0)")
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 512, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function setCameraFromAngle(angle) {
  const cam = STATE.camera
  if (!cam) return
  cam.position.x = Math.cos(angle) * CAMERA_RADIUS
  cam.position.z = Math.sin(angle) * CAMERA_RADIUS
  cam.position.y = CAMERA_HEIGHT
  cam.lookAt(CAMERA_LOOK_AT)
}

function loadCarGLB(carId, assetName) {
  if (STATE.glbCache.has(carId)) {
    return Promise.resolve(STATE.glbCache.get(carId))
  }
  const loader = new GLTFLoader()
  return loader
    .loadAsync(`/models/${assetName}.glb`)
    .then((g) => {
      STATE.glbCache.set(carId, g.scene)
      return g.scene
    })
    .catch((e) => {
      console.warn("[heroScene] GLB load failed", assetName, e)
      return null
    })
}

// V1.9.0: detect what role each mesh plays in the GLB (body panel,
// glass, wheels/tires, lights) by name + material hints, and tune
// material params accordingly.
//   – "body" panels: high metalness + low roughness + clearcoat for
//     a deep-paint look. Env-map already supplied via scene.environment.
//   – "glass" (canopy / windshield): transparent, low roughness, IOR.
//   – "wheel-*" / "tire": kept matte black-ish.
function tuneCarMaterials(root) {
  root.traverse((c) => {
    if (!c.isMesh || !c.material) return
    const mats = Array.isArray(c.material) ? c.material : [c.material]
    const fresh = mats.map((m) => (m ? m.clone() : m))
    for (let i = 0; i < fresh.length; i++) {
      const m = fresh[i]
      if (!m) continue
      const name = (c.name || "").toLowerCase()
      const isWheel = /wheel|tire|tyre|rim/.test(name)
      const isGlass = /glass|window|wind(shield|screen)|canopy/.test(name) ||
                       (typeof m.opacity === "number" && m.opacity < 0.95)
      const isLight = /headlight|brake-?light|tail-?light|lamp/.test(name)
      if (isWheel) {
        if ("metalness" in m) m.metalness = 0.35
        if ("roughness" in m) m.roughness = 0.78
      } else if (isGlass) {
        m.transparent = true
        m.opacity = 0.42
        if ("metalness" in m) m.metalness = 0.0
        if ("roughness" in m) m.roughness = 0.12
        if ("ior" in m) m.ior = 1.5
        if ("transmission" in m) m.transmission = 0.6
      } else if (isLight) {
        // Leave lights alone; their emissive carries them.
      } else {
        // Body panel (or unknown — treat as paint).
        if ("metalness" in m) m.metalness = 0.85
        if ("roughness" in m) m.roughness = 0.32
        if ("clearcoat" in m) m.clearcoat = 0.85
        if ("clearcoatRoughness" in m) m.clearcoatRoughness = 0.18
        if ("envMapIntensity" in m) m.envMapIntensity = 1.25
      }
      m.needsUpdate = true
    }
    c.material = Array.isArray(c.material) ? fresh : fresh[0]
  })
}

function setCarFromGLB(srcScene) {
  if (!STATE.scene) return
  if (STATE.carRoot) {
    STATE.scene.remove(STATE.carRoot)
    STATE.carRoot.traverse((c) => {
      if (c.isMesh && c.material) {
        const arr = Array.isArray(c.material) ? c.material : [c.material]
        for (const m of arr) m.dispose?.()
      }
    })
    STATE.carRoot = null
  }
  if (!srcScene) return
  const clone = srcScene.clone(true)
  const box = new THREE.Box3().setFromObject(clone)
  const size = box.getSize(new THREE.Vector3())
  const centre = box.getCenter(new THREE.Vector3())
  clone.position.sub(centre)
  const longest = Math.max(size.x, size.z)
  const scale = longest > 0 ? 6.5 / longest : 1
  const wrap = new THREE.Group()
  wrap.add(clone)
  wrap.scale.setScalar(scale)
  const wrapBox = new THREE.Box3().setFromObject(wrap)
  wrap.position.y -= wrapBox.min.y
  // Drop the car a hair so the wheels touch the stage disc.
  wrap.position.y -= 0.02
  // V1.9.4-3: stash the natural y so updateHeroLayout can rebase the
  // per-mode y-offset from a known reference instead of compounding.
  wrap.userData._baseY = wrap.position.y
  tuneCarMaterials(wrap)
  STATE.scene.add(wrap)
  STATE.carRoot = wrap
  // Reset entry animation each time a new car is mounted.
  STATE.entryStart = performance.now()
  STATE.entryDone = false
  wrap.scale.multiplyScalar(0.92)   // start small, will scale up in tick()
  wrap.userData._baseScale = scale
  // Apply current layout-mode tuning immediately so the first paint
  // already reflects mobile-full overrides if applicable.
  updateHeroLayout()
  // V1.9.6-4: GLB just landed → fade out the poster (if it was shown).
  hidePosterFallback()
}

// V1.9.6-4: poster fallback for slow / failed 3D paths. Shown 600 ms
// after startHeroScene() if carRoot is still null. Hidden once
// setCarFromGLB completes successfully. Implementation is just two
// classList toggles on #heroPoster — CSS does the opacity transition.
function showPosterFallback() {
  const el = document.getElementById("heroPoster")
  if (!el) return
  el.classList.add("hero-poster-show")
}
function hidePosterFallback() {
  const el = document.getElementById("heroPoster")
  if (!el) return
  el.classList.remove("hero-poster-show")
}
function refreshPosterLabel(carName) {
  const el = document.getElementById("heroPosterLabel")
  if (el && carName) el.textContent = carName
}

// V1.9.4-3: per-layoutMode camera FOV + car scale/position. Re-applied
// on visualViewport.resize / orientationchange so a rotation between
// portrait and landscape lands in the right framing.
function updateHeroLayout() {
  if (!STATE.camera) return
  const mode = document.documentElement.dataset.layoutMode
  const cfg = HERO_LAYOUT[mode] ?? HERO_LAYOUT.default
  STATE.camera.fov = cfg.fov
  STATE.camera.updateProjectionMatrix()
  const car = STATE.carRoot
  if (!car) return
  const base = car.userData._baseScale ?? 1
  // Save the per-mode scale so the entry animation can read it.
  car.userData._modeScaleMul = cfg.carScale
  // Don't clobber the entry-anim mid-grow — let tick() apply final scale.
  if (STATE.entryDone) {
    car.scale.setScalar(base * cfg.carScale)
  }
  const baseY = car.userData._baseY ?? 0
  car.position.set(cfg.carPos.x, baseY + cfg.carPos.y, cfg.carPos.z)
}

if (typeof window !== "undefined") {
  // V1.9.4-3: defer to a microtask via setTimeout 0 so layoutMode.js's
  // resize listener (registered later in module-import order) gets a
  // chance to update <html data-layout-mode> BEFORE heroScene reads it.
  // Otherwise heroScene picks up the stale mode and applies the wrong
  // FOV / car scale.
  const _scheduleHeroLayout = () => setTimeout(updateHeroLayout, 0)
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", _scheduleHeroLayout)
  }
  window.addEventListener("resize", _scheduleHeroLayout)
  window.addEventListener("orientationchange", () => setTimeout(updateHeroLayout, 200))
}

// V1.9.0: stop-pan-stop camera path.
//   – The cycle is split into N stops × (DWELL_S + PAN_S).
//   – Inside each slot, t in [0..1]:
//       t < DWELL_S/(DWELL_S+PAN_S)  → camera holds at the previous angle.
//       t >= that                   → camera lerps toward the next angle.
//   – Lerp uses a smoothstep ease for natural deceleration.
function updateCameraOrbit(now) {
  const t = (now / 1000) % CYCLE_S
  const slot = DWELL_S + PAN_S
  const i = Math.floor(t / slot)
  const fromAngle = STOP_ANGLES[i % STOP_ANGLES.length]
  const toAngle = STOP_ANGLES[(i + 1) % STOP_ANGLES.length]
  // Make sure the orbit always moves the SHORT way around the circle.
  let delta = toAngle - fromAngle
  while (delta > Math.PI) delta -= 2 * Math.PI
  while (delta < -Math.PI) delta += 2 * Math.PI
  const tInSlot = t - i * slot
  let f
  if (tInSlot < DWELL_S) {
    f = 0
  } else {
    const u = (tInSlot - DWELL_S) / PAN_S      // 0..1 across the pan
    f = u * u * (3 - 2 * u)                    // smoothstep
  }
  STATE.camAngle = fromAngle + delta * f
  setCameraFromAngle(STATE.camAngle)
}

function updateEntryAnimation(now) {
  if (STATE.entryDone || !STATE.carRoot) return
  const elapsed = (now - STATE.entryStart) / 1000
  const ENTRY_DUR = 0.72
  const u = Math.min(1, elapsed / ENTRY_DUR)
  // smoothstep for both opacity and scale-up.
  const e = u * u * (3 - 2 * u)
  const base = STATE.carRoot.userData._baseScale ?? 1
  // V1.9.4-3: multiply by per-mode scale so mobile-full enters at 0.78×
  // its natural size and stops there, instead of overshooting to 1.0.
  const modeMul = STATE.carRoot.userData._modeScaleMul ?? 1
  const s = base * modeMul * (0.92 + 0.08 * e)
  STATE.carRoot.scale.setScalar(s)
  if (u >= 1) STATE.entryDone = true
}

function tick(now) {
  if (!STATE.running) return
  const t = now / 1000
  const last = STATE.lastTime || t
  STATE.lastTime = t
  // suppress unused-var lint without needing dt anymore
  void last
  updateCameraOrbit(now)
  updateEntryAnimation(now)
  STATE.renderer.render(STATE.scene, STATE.camera)
  STATE.rafId = requestAnimationFrame(tick)
}

export function startHeroScene({ mountId = "heroCarMount", carId, assetName } = {}) {
  const mount = document.getElementById(mountId)
  if (!mount) {
    console.warn("[heroScene] mount missing:", mountId)
    return
  }
  STATE.mount = mount
  ensureRendererForMount(mount)
  if (carId && assetName && (!STATE.carRoot || STATE._pendingCarId !== carId)) {
    STATE._pendingCarId = carId
    // V1.9.6-4: schedule poster fallback. If the GLB hasn't landed within
    // 600 ms (slow CDN, WebView GPU stall, network hiccup) the poster
    // SVG fades in. setCarFromGLB calls hidePosterFallback() the moment
    // the car is actually mounted, so a 1.2 s load shows poster from
    // 600 ms onward and fades it back out at 1.2 s with a clean
    // transition both ways.
    if (typeof window !== "undefined" && STATE._posterTimer) {
      clearTimeout(STATE._posterTimer)
    }
    STATE._posterTimer = setTimeout(() => {
      if (!STATE.carRoot) showPosterFallback()
    }, 600)
    loadCarGLB(carId, assetName).then((src) => {
      if (STATE._pendingCarId === carId) setCarFromGLB(src)
    })
  }
  if (STATE.running) return
  STATE.running = true
  STATE.lastTime = 0
  STATE.rafId = requestAnimationFrame(tick)
}

export function stopHeroScene({ keepFlag = false } = {}) {
  if (!keepFlag) STATE.running = false
  if (STATE.rafId) {
    cancelAnimationFrame(STATE.rafId)
    STATE.rafId = 0
  }
}

export function refreshHeroCar({ carId, assetName }) {
  if (!STATE.scene) {
    STATE._pendingCarId = carId ?? null
    return
  }
  STATE._pendingCarId = carId
  loadCarGLB(carId, assetName).then((src) => {
    if (STATE._pendingCarId === carId) setCarFromGLB(src)
  })
}

if (typeof window !== "undefined") {
  window.__heroScene = {
    state: STATE,
    start: startHeroScene,
    stop: stopHeroScene,
    refresh: refreshHeroCar,
  }
}
