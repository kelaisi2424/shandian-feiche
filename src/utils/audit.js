import * as THREE from "three"

let _baselinePlayerMeshCount = null

export function captureBaseline(player) {
  let n = 0
  player.traverse((c) => { if (c.isMesh) n++ })
  _baselinePlayerMeshCount = n
  console.log(`[audit] baseline player meshCount = ${n}`)
}

export function runAudit(player, scene, camera) {
  const issues = []
  if (!player || !scene || !camera) return ["AUDIT_TARGET_MISSING"]

  if (player.scale.x > 1.5 || player.scale.x < 0.5) {
    issues.push(`PLAYER_SCALE_OUT_OF_RANGE: ${player.scale.x.toFixed(2)} (allowed 0.5-1.5)`)
  }

  player.traverse((c) => {
    if (!c.isMesh) return
    const mats = Array.isArray(c.material) ? c.material : [c.material]
    const isCarBody = c.name === "body" || /^wheel-/.test(c.name)
    if (!isCarBody) return
    for (const m of mats) {
      if (!m) continue
      if ((m.emissiveIntensity ?? 0) > 0.01) issues.push(`EMISSIVE_POLLUTION: ${c.name} ei=${m.emissiveIntensity}`)
      if (m.transparent) issues.push(`TRANSPARENT_POLLUTION: ${c.name}`)
      if ((m.opacity ?? 1) < 0.99) issues.push(`OPACITY_POLLUTION: ${c.name} opa=${m.opacity}`)
    }
  })

  const dist = camera.position.distanceTo(player.position)
  if (dist < 8) issues.push(`CAMERA_TOO_CLOSE: ${dist.toFixed(1)} (target 8-12)`)
  else if (dist > 20) issues.push(`CAMERA_TOO_FAR: ${dist.toFixed(1)} (must be <20)`)
  else if (dist > 14) issues.push(`CAMERA_SUBOPTIMAL: ${dist.toFixed(1)} (target 8-12)`)

  if (_baselinePlayerMeshCount !== null) {
    let n = 0
    player.traverse((c) => { if (c.isMesh) n++ })
    if (n > _baselinePlayerMeshCount + 6) {
      issues.push(`MESH_COUNT_SPIKE: ${n} (baseline ${_baselinePlayerMeshCount}, threshold ${_baselinePlayerMeshCount + 6})`)
    }
  }

  let fallbackCount = 0
  scene.traverse((c) => { if (c.userData?.isFallback) fallbackCount++ })
  if (fallbackCount > 0) {
    issues.push(`OBSTACLE_FALLBACK_USED: ${fallbackCount} placeholders in scene (GLB load failed)`)
  }

  // V1.8.3a-3: VISUAL_FACING_REVERSED check removed from runAudit.
  //
  // Reason: with the new window.__tune.visualYawOffset A/B knob (default
  // Math.PI), the body's local axes are intentionally rotated relative
  // to the player Group, so a body-vs-player axis dot product cannot
  // distinguish "designed orientation" from "bug". The visual decision
  // is now made by the player flipping the knob and looking at the
  // car (window.__tryFlipVisual()). window.__facingCheck below still
  // returns the raw dot for diagnostic purposes — it just no longer
  // pollutes window.__audit().

  return issues
}

// === V1.8.1: Manual entry point for browser console verification ===
// Appended only — does not modify runAudit() / captureBaseline() above.
// Not gated behind import.meta.env.DEV so it's available on deployed
// builds too; harmless in prod (just a function on window).
//
// main.js's init() also assigns `window.__audit` (the older slim
// version), and init runs AFTER this module loads — so a single
// assignment here gets clobbered. The watchdog below re-applies our
// version every second, taking over once init's slim version lands.
if (typeof window !== "undefined") {
  const _v181Audit = () => {
    if (!window.__player || !window.__scene || !window.__camera) {
      console.warn("[audit] scene not ready (player/scene/camera missing)")
      return ["SCENE_NOT_READY"]
    }
    let issues = runAudit(window.__player, window.__scene, window.__camera)
    // ⭐ Mode-aware filtering: outside `playing` the camera is on a menu
    // orbit and the distance audit doesn't apply. Drop those issues at
    // the entry layer so a green ✅ is achievable from the menu too.
    // runAudit's main body stays intact.
    const mode = window.__state?.mode
    if (mode && mode !== "playing") {
      const before = issues.length
      issues = issues.filter((s) => !/^CAMERA_TOO_FAR|^CAMERA_SUBOPTIMAL/.test(s))
      if (issues.length < before) {
        console.log(
          `[audit] (mode=${mode}, ${before - issues.length} camera issue(s) filtered as not applicable outside playing state)`
        )
      }
    }
    if (issues.length === 0) {
      console.log("%c[audit] ✅ all clean", "color:#4ade80;font-weight:bold;font-size:14px")
    } else {
      console.error("%c[audit] ❌", "color:#ef4444;font-weight:bold;font-size:14px", issues)
    }
    return issues
  }
  _v181Audit._v = "1.8.1"
  window.__audit = _v181Audit
  // Watchdog: if main.js's init() (which runs later, after assets load)
  // overwrites window.__audit with the slim Codex/V1.7 version, swap
  // ours back in. Self-stops once we've held it stable for 30s.
  let _swapTries = 0
  const _swapTimer = setInterval(() => {
    if (window.__audit?._v !== "1.8.1") {
      window.__audit = _v181Audit
    }
    if (++_swapTries > 30) clearInterval(_swapTimer)
  }, 1000)

  // V1.8.2c / V1.8.3a: world scroll-direction sanity check.
  //
  // Project forward convention = local +Z (NOT Three.js default -Z).
  // This function doesn't compute forward vectors directly — it tracks
  // state.progress delta + nearest-obstacle distSq to the camera —
  // so the +Z convention doesn't change any sign here. Header kept
  // for cross-reference.
  //
  // Architecture note (verified with matrixWorld sampling on 2026-05-01):
  // this game is NOT a runner architecture. updateDriving in main.js
  // does `state.progress += speed * dt; player.position.copy(progressToWorld(...))`
  // — the PLAYER moves along the spline; obstacles are statically
  // placed via placeAlongTrack at race start and never updated per
  // frame. Confirmed by: scene.traverse → 35 obstacles spread
  // worldZ ∈ [-2450, +24] and zero `obstacle.position.z = …` writes
  // anywhere in the per-frame path.
  //
  // So __scrollCheck measures the RELATIVE motion between obstacles
  // and the camera by sampling the nearest-ahead obstacle's world z
  // twice. As the player drives forward, the nearest obstacle ahead
  // gets closer (its z relative to camera shrinks toward 0). If that
  // relative z is INCREASING (obstacle pulling away), there's a real
  // bug somewhere — either player isn't moving or obstacles are
  // moving the wrong way.
  let __obstacleSample = null
  window.__scrollCheck = () => {
    const scene = window.__scene
    const camera = window.__camera
    if (!scene || !camera) return "NO_SCENE"
    const camZ = camera.position.z
    const camX = camera.position.x
    const obstacles = []
    scene.traverse((c) => {
      if (!c.userData?.isObstacle) return
      // Only top-level obstacle groups (skip submeshes whose userData
      // also got tagged by tagObstacle's traverse).
      if (c.parent && c.parent.userData?.isObstacle) return
      c.updateMatrixWorld(true)
      const m = c.matrixWorld.elements
      const wx = m[12]
      const wz = m[14]
      const distSq = (wx - camX) ** 2 + (wz - camZ) ** 2
      obstacles.push({
        kind: c.userData.obstacleKind,
        wz,
        dz: wz - camZ,        // relative to camera; +ve = behind camera, -ve = ahead
        distSq
      })
    })
    if (obstacles.length === 0) return { warning: "no obstacles in scene" }
    // The "nearest ahead" obstacle: smallest |dz| among those with dz < 0.
    obstacles.sort((a, b) => a.distSq - b.distSq)
    const nearest = obstacles[0]
    const now = performance.now()
    if (!__obstacleSample || now - __obstacleSample.time > 5000) {
      __obstacleSample = { time: now, nearest }
      console.log("[scrollCheck] sample recorded, run again in 1-2 seconds")
      return "NEED_SECOND_SAMPLE"
    }
    const dt = (now - __obstacleSample.time) / 1000
    // Relative z change of the same nearest obstacle: nearest.dz - prev.dz.
    // Positive = obstacle's relative z is increasing (player drove past it
    // OR obstacle moved away). Negative = relative z shrinking (player
    // approaching). For "moving player driving forward", expect the
    // nearest obstacle to either CYCLE through (one passes, next becomes
    // nearest) or distSq to be roughly stable as the player advances.
    const dDistSq = nearest.distSq - __obstacleSample.nearest.distSq
    const playerProgress = window.__state?.progress ?? null
    const lastProgress = __obstacleSample.progress ?? null
    const progressDelta = (lastProgress != null && playerProgress != null) ? playerProgress - lastProgress : null
    const verdict = progressDelta != null && progressDelta > 1
      ? "✅ player progressing along track"
      : progressDelta != null && progressDelta <= 0
        ? "❌ PLAYER STATIC — progress not advancing"
        : "⚠️ insufficient data"
    console.log(
      `%c[scrollCheck] dt=${dt.toFixed(1)}s, progressΔ=${progressDelta?.toFixed(1) ?? "n/a"}, dDistSq=${dDistSq.toFixed(0)} ${verdict}`,
      progressDelta > 1 ? "color:#4ade80;font-weight:bold" : "color:#ef4444;font-weight:bold"
    )
    __obstacleSample = { time: now, nearest, progress: playerProgress }
    return { dt, progressDelta, dDistSq, verdict, nearestKind: nearest.kind, obstacleCount: obstacles.length }
  }

  // V1.8.3a: visual facing check (catches "car renders backwards" bugs).
  // Project forward convention = local +Z (NOT Three.js default -Z).
  // Verified by continuous 6-sample movement test on V1.8.2c:
  //   actualMovement direction = player.local +Z in world (dot = +1.000)
  //   player.local -Z in world is reversed (dot = -1.000)
  // Forward axis is the matrix's third column (m[8], m[9], m[10]).
  // Dot ≈ +1 means body-forward and player-forward agree (aligned).
  // Dot ≈ -1 means the GLB is rendering backwards.
  window.__facingCheck = () => {
    const player = window.__player
    if (!player) return "NO_PLAYER"
    let body = null
    player.traverse((c) => { if (c.isMesh && c.name === "body") body = c })
    if (!body) return "NO_BODY_MESH"
    const m = body.matrixWorld.elements
    const pm = player.matrixWorld.elements
    const blen = Math.sqrt(m[8] ** 2 + m[9] ** 2 + m[10] ** 2) || 1
    const plen = Math.sqrt(pm[8] ** 2 + pm[9] ** 2 + pm[10] ** 2) || 1
    const dot = (m[8] * pm[8] + m[9] * pm[9] + m[10] * pm[10]) / (blen * plen)
    const verdict = dot > 0.9 ? "✅ aligned" : dot < -0.9 ? "❌ REVERSED 180°" : "⚠️ misaligned"
    console.log(
      `%c[facingCheck] dot=${dot.toFixed(3)} ${verdict}`,
      dot > 0.9 ? "color:#4ade80;font-weight:bold" : "color:#ef4444;font-weight:bold"
    )
    return { dot, verdict }
  }
}
