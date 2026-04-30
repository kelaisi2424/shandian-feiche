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

  // V1.8.2: visual facing sanity check. If the player car body's world
  // -Z forward and the player Group's world -Z forward point in opposite
  // directions, the GLB is rendering backwards. Catches the bug where
  // two stacked 180° rotations leave the visual reversed.
  if (player) {
    let body = null
    player.traverse((c) => { if (c.isMesh && c.name === "body") body = c })
    if (body) {
      const m = body.matrixWorld.elements
      const pm = player.matrixWorld.elements
      const blen = Math.sqrt(m[8] ** 2 + m[9] ** 2 + m[10] ** 2) || 1
      const plen = Math.sqrt(pm[8] ** 2 + pm[9] ** 2 + pm[10] ** 2) || 1
      const dot = ((-m[8]) * (-pm[8]) + (-m[9]) * (-pm[9]) + (-m[10]) * (-pm[10])) / (blen * plen)
      if (dot < 0.9) issues.push(`VISUAL_FACING_REVERSED: dot=${dot.toFixed(3)}`)
    }
  }

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

  // V1.8.2: visual facing check (catches "car renders backwards" bugs).
  // Body's world -Z vs player Group's world -Z. Dot ≈ +1 means aligned;
  // dot ≈ -1 means the car is reversed 180°.
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
    const dot = ((-m[8]) * (-pm[8]) + (-m[9]) * (-pm[9]) + (-m[10]) * (-pm[10])) / (blen * plen)
    const verdict = dot > 0.9 ? "✅ aligned" : dot < -0.9 ? "❌ REVERSED 180°" : "⚠️ misaligned"
    console.log(
      `%c[facingCheck] dot=${dot.toFixed(3)} ${verdict}`,
      dot > 0.9 ? "color:#4ade80;font-weight:bold" : "color:#ef4444;font-weight:bold"
    )
    return { dot, verdict }
  }
}
