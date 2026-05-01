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

if (typeof window !== "undefined") {
  // Don't clobber an existing __camTune (hot-reload preserves user
  // edits across page reloads).
  window.__camTune = window.__camTune || {
    deadzone: 0.8,
    followRatio: 0.30,
    dampingRate: 6.0,
  }
}

export {}
