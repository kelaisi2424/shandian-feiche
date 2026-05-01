// V1.8.3a-2: runtime debug lever for the player's max-speed cap.
//
// Usage (browser console on the deployed site):
//   window.__tune.speedCapMultiplier = 0.65   // try 65% top speed
//   window.__tune.speedCapMultiplier = 1.0    // back to default
//
// The multiplier is applied as a POST-LERP clamp in updateDriving:
//
//     state.speed = lerp(state.speed, target, dt * accel)   // unchanged
//     state.speed = Math.min(state.speed, baseCap * mul)    // V1.8.3a-2
//
// Implication for the 0-3s start feel: the lerp toward `target`
// (CFG.maxSpeed for cruise / CFG.nitroSpeed for nitro) runs at the
// same rate as before, so acceleration in absolute km/h-per-second
// is identical to the un-capped run UNTIL state.speed reaches the
// new cap. After that, it just plateaus earlier. We never reduce
// the lerp `target` itself, so the kick at gas-mash time is preserved.
//
// We intentionally do NOT touch:
//   - per-car stats in src/cars.js (topSpeed / accel0to100)
//   - per-level fields
//   - the lerp acceleration constant (CFG.carAccel)
//   - any of the spline / movement / quaternion logic
if (typeof window !== "undefined") {
  window.__tune = window.__tune || {}
  if (typeof window.__tune.speedCapMultiplier !== "number") {
    window.__tune.speedCapMultiplier = 1.0
  }

  // V1.8.6: A/B knob for the player car's visual yaw — DEFAULT NOW 0.
  //
  // V1.8.3a-3 set the default to Math.PI on the assumption that the
  // pre-V1.8.2 baseline ("looks right") needed a 180° flip. V1.8.6
  // playing-mode geometry measurements falsified that:
  //
  //   GLB nose direction (verified):
  //     wheel-front-* mesh world z ≈ +0.93   (front of car)
  //     wheel-back-*  mesh world z ≈ -0.59   (rear of car)
  //   ⇒ GLB native nose points along local +Z.
  //
  //   With visualYawOffset = Math.PI in playing mode:
  //     visual head direction in world (0, -1)
  //     actual movement direction      (0, +1)
  //     dot = -1.000   ← precisely reversed
  //
  //   With visualYawOffset = 0:
  //     visual head direction = +Z = movement direction
  //     dot = +1.000   ← aligned
  //
  // So the correct default is 0. The knob stays in place and stays
  // flippable via window.__tryFlipVisual() so a future regression
  // can be checked live without a rebuild.
  //
  // Net rotation applied to the player's GLB visual root:
  //   playerBody.rotation.y = modelYawOffset + visualYawOffset - steerTilt
  //
  // Defaults:
  //   modelYawOffset    = 0   (cars.js, untouched here)
  //   visualYawOffset   = 0   (this file)
  //   ⇒ GLB native facing, which IS the forward direction.
  if (typeof window.__tune.visualYawOffset !== "number") {
    window.__tune.visualYawOffset = 0
  }

  window.__tryFlipVisual = () => {
    const cur = window.__tune.visualYawOffset || 0
    const next = Math.abs(cur) < 0.01 ? Math.PI : 0
    window.__tune.visualYawOffset = next
    console.log(`[visualFlip] visualYawOffset = ${next === 0 ? "0" : "Math.PI"}`)
    return next
  }

  // V1.8.6: objective truth check that doesn't rely on a +Z/-Z axis
  // assumption or any user-facing convention.
  //
  //   visual head direction = (avg world position of wheel-front-*) − (avg world position of wheel-back-*)
  //                          normalized
  //   actual movement vector = (player.position now) − (player.position at previous call)
  //                           taken over a 0.5–1.5 s gap
  //   dot = head · movement   (both unit vectors)
  //
  // Usage (browser console, in PLAYING mode while the car is moving):
  //   window.__carTruthCheck()    → records sample 1 (returns NEED_SECOND_SAMPLE)
  //   // wait ~1 second
  //   window.__carTruthCheck()    → returns { dot, verdict }
  //
  //   dot > +0.9  → ✅ visual head and motion agree
  //   dot < -0.9  → ❌ car is rendering BACKWARDS relative to motion
  //   between    → ⚠️ ambiguous (camera spin, very low speed, etc.)
  //
  // No fragile heuristics: no axis sign, no headlight colour, no body
  // mesh name. Pure wheel geometry + position delta.
  let _carTruthSample = null
  window.__carTruthCheck = () => {
    const player = window.__player
    if (!player) return "NO_PLAYER"
    if (window.__state?.mode !== "playing") {
      console.warn("[carTruthCheck] only meaningful in playing mode (current: " + window.__state?.mode + ")")
      return "NOT_PLAYING"
    }
    // Collect world-position averages for front and back wheels.
    const front = { x: 0, y: 0, z: 0, n: 0 }
    const back = { x: 0, y: 0, z: 0, n: 0 }
    player.updateMatrixWorld(true)
    player.traverse((c) => {
      if (!c.isMesh) return
      if (!/^wheel-(front|back)-/.test(c.name)) return
      c.updateMatrixWorld(true)
      const m = c.matrixWorld.elements
      const bucket = c.name.startsWith("wheel-front-") ? front : back
      bucket.x += m[12]; bucket.y += m[13]; bucket.z += m[14]; bucket.n++
    })
    if (front.n === 0 || back.n === 0) return "NO_WHEELS"
    const fx = front.x / front.n, fy = front.y / front.n, fz = front.z / front.n
    const bx = back.x / back.n,  by = back.y / back.n,  bz = back.z / back.n
    // Visual head direction: from rear-axle midpoint to front-axle midpoint.
    let hx = fx - bx, hy = fy - by, hz = fz - bz
    const hLen = Math.hypot(hx, hy, hz) || 1
    hx /= hLen; hy /= hLen; hz /= hLen
    // Sample player world position for the movement leg.
    const px = player.position.x, py = player.position.y, pz = player.position.z
    const now = performance.now()
    if (!_carTruthSample || now - _carTruthSample.time > 5000) {
      _carTruthSample = { time: now, px, py, pz, hx, hy, hz }
      console.log("[carTruthCheck] sample 1 recorded; call again in 0.5–1.5 s while the car is moving")
      return "NEED_SECOND_SAMPLE"
    }
    const dt = (now - _carTruthSample.time) / 1000
    let mx = px - _carTruthSample.px
    let my = py - _carTruthSample.py
    let mz = pz - _carTruthSample.pz
    const mLen = Math.hypot(mx, my, mz)
    if (mLen < 0.05) {
      _carTruthSample = { time: now, px, py, pz, hx, hy, hz }
      console.warn("[carTruthCheck] player barely moved (Δ=" + mLen.toFixed(3) + "m over " + dt.toFixed(2) + "s); try again at speed")
      return { dt, movement: mLen, verdict: "⚠️ NOT_MOVING" }
    }
    mx /= mLen; my /= mLen; mz /= mLen
    const dot = hx * mx + hy * my + hz * mz
    const verdict = dot > 0.9 ? "✅ visual head agrees with motion"
                  : dot < -0.9 ? "❌ CAR IS RENDERING BACKWARDS"
                  : "⚠️ misaligned (turn / low speed)"
    console.log(
      `%c[carTruthCheck] dot=${dot.toFixed(3)} over Δ=${mLen.toFixed(2)}m / ${dt.toFixed(2)}s ${verdict}`,
      dot > 0.9 ? "color:#4ade80;font-weight:bold;font-size:13px"
        : dot < -0.9 ? "color:#ef4444;font-weight:bold;font-size:13px"
        : "color:#facc15;font-weight:bold;font-size:13px"
    )
    _carTruthSample = { time: now, px, py, pz, hx, hy, hz }
    return {
      dot: +dot.toFixed(4),
      dt: +dt.toFixed(2),
      head: { x: +hx.toFixed(3), y: +hy.toFixed(3), z: +hz.toFixed(3) },
      movement: { x: +mx.toFixed(3), y: +my.toFixed(3), z: +mz.toFixed(3), magnitude: +mLen.toFixed(2) },
      verdict
    }
  }
}
