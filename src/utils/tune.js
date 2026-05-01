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
}
