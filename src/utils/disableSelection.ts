// V3 D2 (P0-2): global gesture / selection lockdown.
//
// On iOS Safari + Android Chrome + WeChat WebView the default
// behaviour for a long-press is "show the context menu", "highlight
// text", "show share sheet" or "save image". Inside a 3D racing game
// each of those is a usability bug — the player presses the GAS
// button hard, holds for 0.6 s, the OS pops a menu, the touch target
// is lost.
//
// Six layers of defence here:
//
//   1. CSS `user-select`, `-webkit-touch-callout`, `-webkit-tap-
//      highlight-color` (in styles.css; this file just makes sure the
//      JS-side covers what CSS misses).
//
//   2. `contextmenu` event preventDefault — kills the long-press
//      menu on Android Chrome / desktop right-click.
//
//   3. `selectstart` / `dragstart` preventDefault — no accidental
//      text-selection or image-drag on tap.
//
//   4. iOS pinch-to-zoom: `gesturestart`, `gesturechange`, `gestureend`
//      preventDefault. The viewport meta `maximum-scale=1.0,
//      user-scalable=no` should already block this, but Safari
//      ignores user-scalable=no on accessibility-overridden devices,
//      so a JS guard is safer.
//
//   5. iOS double-tap-to-zoom: track time between touchends; if a
//      second touchend lands within 350 ms we preventDefault.
//
//   6. Pull-to-refresh / overscroll: `touchmove` on document
//      preventDefault when the touch isn't on a scrollable element.
//      Pmndrs racing-game has no scrollable areas at all, so the
//      check simplifies to "any document-level touchmove → cancel".
//
// All six install once on import; idempotent because each call removes
// the previous listener before re-adding (so HMR doesn't double-fire).

let _installed = false

export function installGestureLockdown(): void {
  if (_installed) return
  if (typeof window === 'undefined') return
  _installed = true

  const stop = (e: Event) => {
    if (e.cancelable) e.preventDefault()
  }

  // Layer 2 — context menu
  window.addEventListener('contextmenu', stop, { passive: false })

  // Layer 3 — selection / drag
  window.addEventListener('selectstart', stop, { passive: false })
  window.addEventListener('dragstart', stop, { passive: false })

  // Layer 4 — iOS pinch
  window.addEventListener('gesturestart', stop, { passive: false })
  window.addEventListener('gesturechange', stop, { passive: false })
  window.addEventListener('gestureend', stop, { passive: false })

  // Layer 5 — iOS double-tap zoom
  let _lastTouchEnd = 0
  window.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now()
      if (now - _lastTouchEnd <= 350) {
        if (e.cancelable) e.preventDefault()
      }
      _lastTouchEnd = now
    },
    { passive: false },
  )

  // Layer 6 — pull-to-refresh / overscroll. We DO want touchmove on
  // game elements (the touch buttons listen for it). So scope the
  // cancel to direct document-level moves only — anything inside a
  // button or canvas already calls preventDefault on its own handler.
  document.addEventListener(
    'touchmove',
    (e) => {
      // Only single-finger document-level moves; multi-touch is the
      // pinch path which Layer 4 already handles.
      if (e.touches.length === 1 && e.cancelable) {
        // Walk up the target; if we're on a known interactive element
        // (canvas, our touch buttons) leave the move alone — those
        // need it for steering / drift response. Otherwise cancel
        // (kills overscroll bounce + pull-to-refresh).
        let el = e.target as Element | null
        while (el && el !== document.body) {
          if (el.tagName === 'CANVAS') return
          if (el.getAttribute && el.getAttribute('data-testid')?.startsWith('touch-')) return
          el = el.parentElement
        }
        e.preventDefault()
      }
    },
    { passive: false },
  )
}
