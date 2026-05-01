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
}
