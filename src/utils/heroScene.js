// V1.8.9: independent 3D scene for the home page hero card.
//
// Why a SEPARATE three.js scene/camera/renderer:
//   1. The main game scene is driven by the spline + race state and
//      its camera is in V1.8.7 chase-mode coupling. Touching it would
//      break the V1.8.7 camera-direction work and the V1.8.8 pause logic.
//   2. The hero only needs to render a single car on a turntable. A
//      fresh tiny renderer with its own canvas is the cleanest split.
//
// Lifecycle:
//   start({ glb }) — mounts canvas into #heroCarMount, kicks RAF.
//   stop()         — cancels RAF and parks the renderer (GPU at idle).
//   refresh({ carId }) — swap to a different car GLB (used when the
//                        garage selection changes).
//
// Mode-gating:
//   start() and stop() are called from main.js setMode():
//     - mode === "menu" / "boot" → start()
//     - any other mode           → stop()
//   While stopped, no RAF callback is scheduled, so GPU drops to 0.
//
// devicePixelRatio is clamped to 2 to keep cost bounded on 3x screens.

import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"

const STATE = {
  mount: null,         // <div id="heroCarMount">
  canvas: null,        // owned, appended to mount
  renderer: null,      // THREE.WebGLRenderer
  scene: null,
  camera: null,
  carRoot: null,       // THREE.Group containing the GLB scene
  ro: null,            // ResizeObserver on the mount
  rafId: 0,
  lastTime: 0,
  running: false,
  // cache of raw GLB scenes by carId so swapping cars doesn't re-fetch.
  glbCache: new Map(),
  // pending state from a refresh() call that arrived before mount.
  _pendingCarId: null,
}

const ROTATION_RAD_PER_SEC = (25 * Math.PI) / 180   // 25°/s

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
  renderer.toneMappingExposure = 1.0
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
  // Studio env so the metal/clearcoat reads as a paint job, not flat.
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  pmrem.dispose()

  const camera = new THREE.PerspectiveCamera(28, w / h, 0.1, 100)
  // Look from above-front, ~30° pitch, far enough to frame a 6.5m car.
  camera.position.set(0, 5.6, 9.6)
  camera.lookAt(0, 0.7, 0)

  // Soft fill so the underside doesn't crush to black.
  scene.add(new THREE.AmbientLight(0xffffff, 0.45))
  // Key light from camera-right, warm.
  const key = new THREE.DirectionalLight(0xfff2c8, 1.4)
  key.position.set(6, 9, 5)
  scene.add(key)
  // Rim light from behind to outline the silhouette.
  const rim = new THREE.DirectionalLight(0x7ec0ff, 0.85)
  rim.position.set(-4, 3.4, -7)
  scene.add(rim)

  // A tiny disc under the car so it doesn't float in space.
  const padGeo = new THREE.CircleGeometry(2.6, 48)
  const padMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.32,
  })
  const pad = new THREE.Mesh(padGeo, padMat)
  pad.rotation.x = -Math.PI / 2
  pad.position.y = 0.001
  scene.add(pad)

  STATE.renderer = renderer
  STATE.canvas = canvas
  STATE.scene = scene
  STATE.camera = camera

  // Resize: track the mount's CSS box, not the window. The home page
  // stage scales as one unit so the mount can grow/shrink during a
  // window resize even though the viewport hasn't changed in CSS px.
  STATE.ro = new ResizeObserver(() => {
    if (!STATE.renderer || !STATE.mount) return
    const cw = Math.max(1, STATE.mount.clientWidth)
    const ch = Math.max(1, STATE.mount.clientHeight)
    STATE.renderer.setSize(cw, ch, false)
    STATE.camera.aspect = cw / ch
    STATE.camera.updateProjectionMatrix()
  })
  STATE.ro.observe(mount)
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

function setCarFromGLB(srcScene) {
  if (!STATE.scene) return
  // Remove previous car
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
  // Normalize visual size: scale so the longest horizontal extent ≈ 6.5m,
  // centre on origin and rest on y=0.
  const box = new THREE.Box3().setFromObject(clone)
  const size = box.getSize(new THREE.Vector3())
  const centre = box.getCenter(new THREE.Vector3())
  clone.position.sub(centre)
  const longest = Math.max(size.x, size.z)
  const scale = longest > 0 ? 6.5 / longest : 1
  const wrap = new THREE.Group()
  wrap.add(clone)
  wrap.scale.setScalar(scale)
  // Rest on the ground after scaling (recompute bbox with the scale applied).
  const wrapBox = new THREE.Box3().setFromObject(wrap)
  wrap.position.y -= wrapBox.min.y
  // Tighten material params for a showroom look.
  wrap.traverse((c) => {
    if (!c.isMesh || !c.material) return
    const arr = Array.isArray(c.material) ? c.material : [c.material]
    for (const m of arr) {
      if (!m) continue
      if ("metalness" in m) m.metalness = Math.max(m.metalness ?? 0, 0.6)
      if ("roughness" in m) m.roughness = Math.min(m.roughness ?? 0.5, 0.42)
    }
  })
  STATE.scene.add(wrap)
  STATE.carRoot = wrap
}

function tick(now) {
  if (!STATE.running) return
  const t = now / 1000
  const last = STATE.lastTime || t
  const dt = Math.min(0.05, t - last)
  STATE.lastTime = t
  if (STATE.carRoot) STATE.carRoot.rotation.y += dt * ROTATION_RAD_PER_SEC
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
  // First start, or no car yet — load the requested one.
  if (carId && assetName && (!STATE.carRoot || STATE._pendingCarId !== carId)) {
    STATE._pendingCarId = carId
    loadCarGLB(carId, assetName).then((src) => {
      // Only apply if user hasn't requested a different car since.
      if (STATE._pendingCarId === carId) setCarFromGLB(src)
    })
  }
  if (STATE.running) return
  STATE.running = true
  STATE.lastTime = 0
  STATE.rafId = requestAnimationFrame(tick)
}

export function stopHeroScene() {
  STATE.running = false
  if (STATE.rafId) {
    cancelAnimationFrame(STATE.rafId)
    STATE.rafId = 0
  }
}

export function refreshHeroCar({ carId, assetName }) {
  if (!STATE.scene) {
    // Mount hasn't been wired up yet — record so the next start picks it up.
    STATE._pendingCarId = carId ?? null
    return
  }
  STATE._pendingCarId = carId
  loadCarGLB(carId, assetName).then((src) => {
    if (STATE._pendingCarId === carId) setCarFromGLB(src)
  })
}

// Diagnostic accessor (browser console: window.__heroScene)
if (typeof window !== "undefined") {
  window.__heroScene = {
    state: STATE,
    start: startHeroScene,
    stop: stopHeroScene,
    refresh: refreshHeroCar,
  }
}
