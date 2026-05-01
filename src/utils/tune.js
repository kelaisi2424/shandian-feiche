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

  // V1.8.3a-3: A/B knob for the player car's visual yaw.
  //
  // Background: V1.8.2 introduced cars.js modelYawOffset (default 0)
  // intending to "use the GLB's natural facing". In practice many
  // testers reported the car still looked reversed at certain camera
  // angles. Rather than continuing to argue the theoretical "correct"
  // axis, this knob layers a SECOND yaw offset on top of modelYawOffset
  // — defaulting to Math.PI — that can be flipped live in the browser
  // console without rebuilding.
  //
  // Net rotation applied to the player's GLB visual root:
  //   playerBody.rotation.y = modelYawOffset + visualYawOffset - steerTilt
  //
  // Defaults:
  //   modelYawOffset    = 0       (cars.js, untouched here)
  //   visualYawOffset   = Math.PI (this file)
  //   ⇒ same net rotation as the pre-V1.8.2 hard-coded `Math.PI` baseline.
  //
  // To live-test the alternative (no rotation, GLB natural facing):
  //   window.__tryFlipVisual()   // toggles visualYawOffset 0 ↔ Math.PI
  if (typeof window.__tune.visualYawOffset !== "number") {
    window.__tune.visualYawOffset = Math.PI
  }

  window.__tryFlipVisual = () => {
    const cur = window.__tune.visualYawOffset || 0
    const next = Math.abs(cur) < 0.01 ? Math.PI : 0
    window.__tune.visualYawOffset = next
    console.log(`[visualFlip] visualYawOffset = ${next === 0 ? "0" : "Math.PI"}`)
    return next
  }
}
