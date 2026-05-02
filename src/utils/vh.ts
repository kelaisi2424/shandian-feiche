// V3 D2 (P0-3): iOS Safari 100vh bug fix.
//
// On iOS Safari (and in WeChat WebView on iPhone), `100vh` resolves
// to the LAYOUT viewport — including the chrome that may currently
// be hidden (URL bar). When the user starts scrolling and the bar
// collapses, `100vh` doesn't change but the actually-visible area
// shrinks by ~80 px. Touch buttons positioned at `bottom: 0` end up
// behind the home indicator.
//
// Fix: track `window.innerHeight` ourselves and expose it as a CSS
// custom property `--vh` whose unit IS 1 px. Stylesheets use
// `calc(var(--vh) * 100)` instead of `100vh`. Update on resize +
// orientationchange + visualViewport.resize so the value follows the
// real visible-area height through the URL-bar transition.

let _bound = false

function setVh() {
  if (typeof window === 'undefined') return
  // Prefer visualViewport.height — it's the only signal that tracks
  // the URL-bar collapse on iOS. Fall back to innerHeight where
  // visualViewport isn't supported (older Android stocks).
  const h = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--vh', `${h * 0.01}px`)
}

export function initVhUnit(): void {
  if (_bound) return
  if (typeof window === 'undefined') return
  _bound = true
  setVh()
  window.addEventListener('resize', setVh)
  window.addEventListener('orientationchange', () => {
    // Post-rotation height isn't ready immediately on Safari.
    setTimeout(setVh, 100)
  })
  window.visualViewport?.addEventListener('resize', setVh)
}
