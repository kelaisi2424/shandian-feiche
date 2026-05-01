// V1.9.3-1: layout-mode picker for the home menu.
//
// Why we need this beyond CSS media queries:
//   1. WeChat in-app browser eats up to 185 px of the top of the
//      viewport for its own chrome, even when "fullscreen" is requested.
//      In landscape that drops the usable height to ~195 px on a phone
//      that's nominally 414 × 896 — far below any sane breakpoint.
//   2. Pure media-query breakpoints can't see safe-area insets +
//      runtime browser chrome. A device that reports vh=300 but has a
//      44 px iOS notch + 34 px home-indicator + a 60 px topbar +
//      80 px actionbar = 218 px of chrome alone — content has 82 px
//      to live in. CSS doesn't know that.
//
// Two-stage decision:
//   Stage 1 (height bands)
//     vh < 240          → ultra-compact   single-row strip, no Hero
//     240 ≤ vh < 480    → compact         simplified menu, smaller bars
//     vh ≥ 480          → full            V1.9.1 showroom layout
//   Stage 2 (overflow guard)
//     If the CURRENT topbar + actionbar offsetHeights + a 120 px Hero
//     minimum already exceed vh, force ultra-compact regardless of
//     band. Catches the edge case where 240–480 px viewports still
//     overflow because of safe-area + browser-chrome stacking.
//
// The result is written to <html data-layout-mode="…"> so CSS can
// branch on `:root[data-layout-mode="…"]` selectors. Recomputed on
// visualViewport resize / orientationchange / window resize so a user
// who rotates / opens the keyboard gets an immediate re-evaluation.

const HERO_MIN_HEIGHT = 120

function computeLayoutMode() {
  const vh = window.visualViewport?.height ?? window.innerHeight
  const vw = window.visualViewport?.width ?? window.innerWidth
  // Stage 1 — height-band classification.
  let mode =
    vh < 240 ? "ultra-compact" :
    vh < 480 ? "compact" :
    "full"
  // Stage 2 — content-overflow guard. Only check if we WOULD have
  // rendered topbar+actionbar (i.e. not already ultra-compact).
  if (mode !== "ultra-compact") {
    const topEl = document.querySelector(".menu-topbar")
    const bottomEl = document.querySelector(".menu-actionbar")
    if (topEl && bottomEl) {
      const topH = topEl.offsetHeight
      const bottomH = bottomEl.offsetHeight
      if (topH + bottomH + HERO_MIN_HEIGHT > vh) {
        mode = "ultra-compact"
      }
    }
  }
  return { mode, vh, vw }
}

export function applyLayoutMode() {
  const { mode, vh, vw } = computeLayoutMode()
  const root = document.documentElement
  if (root.dataset.layoutMode !== mode) {
    root.dataset.layoutMode = mode
    // Single line per change so the console isn't spammed every
    // animation-frame; the resize handlers debounce themselves
    // implicitly because visualViewport.resize fires once per frame.
    console.log(`[layoutMode] ${mode} (vh=${vh}, vw=${vw})`)
  }
}

// Bind to every signal that could change the usable viewport.
// visualViewport is the source of truth on iOS Safari + WeChat WebView;
// the older window.resize + orientationchange are fallbacks for
// browsers that don't expose visualViewport (older Android stock).
if (typeof window !== "undefined") {
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", applyLayoutMode)
  }
  window.addEventListener("resize", applyLayoutMode)
  // Fire after a brief delay so the post-rotation viewport has settled
  // (orientationchange fires before the new dimensions are applied on
  // some Android browsers).
  window.addEventListener("orientationchange", () => {
    setTimeout(applyLayoutMode, 100)
  })
  // First run — must wait for #menu's topbar/actionbar to be in the DOM
  // so Stage 2's offsetHeight reads return real values.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyLayoutMode, { once: true })
  } else {
    applyLayoutMode()
  }
  // Diagnostic accessor — `window.__layoutMode()` in DevTools to read
  // the live state, or to verify a particular viewport size locally.
  window.__layoutMode = () => {
    const r = computeLayoutMode()
    console.log(`[layoutMode] mode=${r.mode}, vh=${r.vh}, vw=${r.vw}`)
    return r
  }
}

export { computeLayoutMode }
