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

  return issues
}
