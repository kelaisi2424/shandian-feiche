// V1.9.4-4: runtime tuning lever for the chase camera's lateral damping.
//
// updateCamera() reads window.__camTune.{deadzone,followRatio,dampingRate}
// every frame, falling back to the literal defaults below. Editing these
// values from the browser console takes effect on the next frame — no
// rebuild, no redeploy.
//
//   deadzone     metres of player lateral the camera ignores. Higher
//                value → camera holds the centreline longer when the
//                player wiggles between lanes. 0 = camera glues to the
//                player. Default 0.8.
//   followRatio  fraction of the player's beyond-deadzone lateral that
//                the camera ultimately rides. 1.0 = camera matches the
//                player's lateral exactly past the deadzone (pre-V1.9.4
//                behaviour). 0.30 = camera lags by ~70% — the player
//                visibly moves left/right inside the frame instead of
//                pulling the world around them. Default 0.30.
//   dampingRate  exponential approach rate (1/sec) toward the new
//                lateral target. Higher = snappier; lower = softer.
//                k = 1 - exp(-rate * dt) per frame. Default 6.0
//                (settles in ~150 ms).
//
// The defaults are tuned for the desktop showroom — try
//   window.__camTune.deadzone = 0     // hard-glue to player
//   window.__camTune.deadzone = 2.0   // camera barely follows
// to feel the lever working live.

// V1.9.7-3: four additional scalars for the chase camera's framing.
// updateCamera reads them per-frame so DevTools edits take effect
// immediately. They control HOW BIG the player car looks on screen
// independently from the V1.9.5-1 lateral damping (which controls
// SMOOTHNESS).
//
//   followDist     metres behind the player the camera sits.
//                  Larger = car looks smaller. Default 11.5 (was 7.5
//                  hard-coded pre-V1.9.7-3 — moved out so we can
//                  shrink it without a rebuild).
//   cameraHeight   metres above the road. Default 3.0 (was 3.4).
//                  Lower = more level-with-the-car shot.
//   lookAhead      metres ahead of the damped anchor the camera
//                  looks. Lower = car centred lower in frame.
//                  Default 5.0 (was 10.0).
//   fov            camera vertical FOV in degrees. Larger = wider
//                  field, makes the car look smaller. Default 54
//                  (was 60 hard-coded inside main.js's camera build).
//
// Combined effect of the new defaults: the player car's screen-width
// occupancy goes from ~8% (pre-V1.9.7-3) to ~13%. The V1.9.5-1
// lateral damping chain (deadzone / followRatio / dampingRate) is
// untouched — the damped anchor still controls the camera X.

if (typeof window !== "undefined") {
  // Don't clobber an existing __camTune (hot-reload preserves user
  // edits across page reloads). New scalars are merged in only if
  // they're missing so a hot-reload after a manual deadzone tweak
  // keeps the deadzone but picks up the new framing defaults.
  window.__camTune = window.__camTune || {}
  const t = window.__camTune
  if (typeof t.deadzone     !== "number") t.deadzone     = 0.8
  if (typeof t.followRatio  !== "number") t.followRatio  = 0.30
  if (typeof t.dampingRate  !== "number") t.dampingRate  = 6.0
  if (typeof t.followDist   !== "number") t.followDist   = 11.5
  if (typeof t.cameraHeight !== "number") t.cameraHeight = 3.0
  if (typeof t.lookAhead    !== "number") t.lookAhead    = 5.0
  if (typeof t.fov          !== "number") t.fov          = 54
}

export {}
