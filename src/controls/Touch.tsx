// V3 D1: touch controls for mobile.
//
// pmndrs/racing-game ships keyboard-only. ontouchstart-in-window is
// false on the upstream demo, so an iPhone in WeChat / Safari can
// load the page but the car never accelerates — no input surface at
// all.
//
// We add four pointer surfaces wired through the existing
// useStore.actions API (forward / backward / left / right / boost /
// brake) so the touch path drops straight into the same control
// state the Keyboard handler already uses:
//
//     LEFT half:   virtual D-pad (4 hit zones in a + shape)
//                  - up arrow   → forward
//                  - down arrow → backward (also acts as brake hold)
//                  - left arrow → left
//                  - right arrow→ right
//     RIGHT half:  3 round buttons stacked vertically
//                  - GAS  (large)        → forward (mirror of D-pad up
//                                          so users without thumbs on
//                                          both sides can drive too)
//                  - NITRO              → boost
//                  - DRIFT              → brake (cannon's brake +
//                                          steer combo IS the drift
//                                          on this physics rig)
//
// Each hit surface is at least 64×64 px and uses `pointerdown` /
// `pointerup` / `pointercancel` / `pointerleave` so the press is
// captured even if the finger drifts off the button. setPointerCapture
// keeps the up event delivered to the same element.

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

const HOLD_BUTTON_STYLE: React.CSSProperties = {
  // Fixed size, never shrinks.
  width: 72,
  height: 72,
  borderRadius: '50%',
  border: '1.5px solid rgba(255,255,255,0.45)',
  background: 'rgba(20,28,48,0.55)',
  color: 'white',
  fontWeight: 800,
  fontSize: 14,
  letterSpacing: 2,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  userSelect: 'none',
  touchAction: 'none',
  // Subtle shadow + cyan inner highlight so the button reads against
  // a busy game scene.
  boxShadow: '0 4px 14px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.16), 0 0 12px rgba(38,214,255,0.12)',
  WebkitTapHighlightColor: 'transparent',
}

// V3 D1 (T2) deleted DPAD_BUTTON_STYLE — was used by the 4-button +
// shape D-pad we replaced with two big circular turn buttons.

type ActionKey = 'forward' | 'backward' | 'left' | 'right' | 'boost' | 'brake'

function HoldButton({
  label,
  action,
  style,
  testid,
}: {
  label: React.ReactNode
  action: ActionKey | ActionKey[]
  style?: React.CSSProperties
  testid?: string
}) {
  const actions = useStore((s) => s.actions)
  const elRef = useRef<HTMLDivElement | null>(null)
  const pressed = useRef(false)
  const fire = (down: boolean) => {
    const list = Array.isArray(action) ? action : [action]
    for (const a of list) actions[a](down)
  }
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault()
    if (!pressed.current) {
      pressed.current = true
      fire(true)
    }
    elRef.current?.setPointerCapture?.(e.pointerId)
  }
  const onUp = (e?: React.PointerEvent) => {
    if (pressed.current) {
      pressed.current = false
      fire(false)
    }
    if (e) {
      try {
        elRef.current?.releasePointerCapture?.(e.pointerId)
      } catch (_) {
        /* noop */
      }
    }
  }
  return (
    <div
      ref={elRef}
      data-testid={testid}
      style={{ ...HOLD_BUTTON_STYLE, ...style }}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => pressed.current && onUp()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </div>
  )
}

export function TouchControls(): JSX.Element | null {
  const ready = useStore((s) => s.ready)
  // Detect touch capability so desktop doesn't get cluttered.
  // V3 D1 fix: also trigger on narrow viewports (≤900 px). Real iPhone
  // Safari has ontouchstart + pointer:coarse, but Chromium DevTools
  // device-mode emulation (and many WebView headless paths) reports
  // false on all three touch capability flags. Keying off width lets
  // the buttons render on those emulators too — which is how you and
  // I will be screenshotting / playtesting before native devices.
  const narrowViewport = typeof window !== 'undefined' && window.innerWidth <= 900
  const isTouch =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window ||
      ((navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints ?? 0) > 0 ||
      window.matchMedia?.('(pointer: coarse)').matches ||
      narrowViewport)

  // Lock the body's touchAction so accidental finger drag doesn't pan
  // the page while we're holding a button.
  useEffect(() => {
    if (!isTouch) return
    const prev = document.body.style.touchAction
    document.body.style.touchAction = 'none'
    return () => {
      document.body.style.touchAction = prev
    }
  }, [isTouch])

  // V3 D1 fix #2: position relative to visualViewport.height instead of
  // bottom: 20px. On real iPhone 13 Safari those two are equal (844 px).
  // In Chromium DevTools emulation OR Claude Preview's resize, the
  // visualViewport is squashed to the requested 844 but window.innerHeight
  // stays at the iframe's native size (often >1000), so bottom:20px
  // anchors the buttons OFF the visible area. Track visualViewport
  // height in state so we re-position when the iframe changes.
  const [vh, setVh] = useState<number>(
    () => (typeof window !== 'undefined' && window.visualViewport?.height) || (typeof window !== 'undefined' ? window.innerHeight : 0),
  )
  const [vw, setVw] = useState<number>(
    () => (typeof window !== 'undefined' && window.visualViewport?.width) || (typeof window !== 'undefined' ? window.innerWidth : 0),
  )
  useEffect(() => {
    if (!isTouch) return
    const update = () => {
      setVh(window.visualViewport?.height ?? window.innerHeight)
      setVw(window.visualViewport?.width ?? window.innerWidth)
    }
    update()
    window.visualViewport?.addEventListener('resize', update)
    window.addEventListener('resize', update)
    return () => {
      window.visualViewport?.removeEventListener('resize', update)
      window.removeEventListener('resize', update)
    }
  }, [isTouch])

  if (!isTouch) return null
  if (!ready) return null

  // V3 D2 (P0-1): auto-throttle + 4 buttons.
  //   LEFT bottom:   ← / →   each 84×84 turn buttons
  //   RIGHT bottom:  漂移   100×100 (DRIFT, doubles as light brake)
  //                  氮气   74×74 (NITRO, above DRIFT)
  // No GAS button — the car drives forward automatically (set by Intro
  // when the user taps "点击开始"; see Intro.tsx). The user only steers
  // and times their drift / nitro. This matches WeChat H5 racing conv.
  // No backward / brake — DRIFT is also a soft slowdown.
  // Safe-area insets honoured via env(safe-area-inset-*).
  const TURN_SIZE = 84
  const DRIFT_SIZE = 100
  const SMALL_SIZE = 74
  const SAFE = 16
  const turnGap = 14
  const turnY = Math.max(0, vh - TURN_SIZE - SAFE)
  const driftX = Math.max(0, vw - DRIFT_SIZE - SAFE)
  const driftY = Math.max(0, vh - DRIFT_SIZE - SAFE)
  const nitroX = Math.max(0, driftX - SMALL_SIZE - 14)
  const nitroY = Math.max(0, driftY - 4) // align with DRIFT vertically a hair higher

  const containerBase: React.CSSProperties = {
    position: 'fixed',
    zIndex: 9000,
    pointerEvents: 'auto',
    userSelect: 'none',
    touchAction: 'none',
  }

  const baseTurn: React.CSSProperties = {
    width: TURN_SIZE,
    height: TURN_SIZE,
    borderRadius: '50%',
    border: '1.5px solid rgba(207, 224, 255, 0.55)',
    background: 'rgba(8, 14, 28, 0.55)',
    color: 'white',
    fontSize: 36,
    fontWeight: 800,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    userSelect: 'none',
    touchAction: 'none',
    boxShadow: '0 6px 14px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.16), 0 0 18px rgba(38,214,255,0.10)',
    WebkitTapHighlightColor: 'transparent',
  }

  return (
    <>
      {/* LEFT — turn buttons */}
      <div data-testid="touch-turn-left-wrap" style={{ ...containerBase, top: turnY, left: SAFE }}>
        <HoldButton testid="touch-left" label="←" action="left" style={baseTurn} />
      </div>
      <div data-testid="touch-turn-right-wrap" style={{ ...containerBase, top: turnY, left: SAFE + TURN_SIZE + turnGap }}>
        <HoldButton testid="touch-right" label="→" action="right" style={baseTurn} />
      </div>

      {/* RIGHT — DRIFT (primary) + NITRO (secondary, top-right of DRIFT)
          V3 D3 (C): de-saturate. Pre-D3 was a glowing orange + glowing
          neon-cyan kart-game pair. Adult-racer wants the same hierarchy
          (DRIFT bigger, primary; NITRO smaller, secondary) but in a
          neutral steel-glass treatment so the buttons read as tools,
          not toys. */}
      <div data-testid="touch-drift-wrap" style={{ ...containerBase, top: driftY, left: driftX }}>
        <HoldButton
          testid="touch-drift"
          label="漂移"
          action="brake"
          style={{
            width: DRIFT_SIZE,
            height: DRIFT_SIZE,
            borderRadius: '50%',
            background: 'rgba(20, 28, 48, 0.62)',
            border: '1.5px solid rgba(207, 224, 255, 0.55)',
            color: 'rgba(220, 232, 250, 0.95)',
            fontSize: 19,
            fontWeight: 600,
            letterSpacing: 3,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none',
            touchAction: 'none',
            boxShadow: '0 6px 16px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.14)',
            WebkitTapHighlightColor: 'transparent',
          }}
        />
      </div>
      <div data-testid="touch-nitro-wrap" style={{ ...containerBase, top: nitroY, left: nitroX }}>
        <HoldButton
          testid="touch-nitro"
          label="氮气"
          action="boost"
          style={{
            width: SMALL_SIZE,
            height: SMALL_SIZE,
            borderRadius: '50%',
            background: 'rgba(14, 22, 40, 0.6)',
            border: '1.5px solid rgba(160, 196, 232, 0.5)',
            color: 'rgba(196, 220, 248, 0.92)',
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none',
            touchAction: 'none',
            boxShadow: '0 5px 14px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.12)',
            WebkitTapHighlightColor: 'transparent',
          }}
        />
      </div>
    </>
  )
}
