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

  // V3 D1 (T2): simplified to 5 buttons total.
  //   LEFT bottom: ← / →   each 84×84
  //   RIGHT bottom stack: GAS (110×110) + DRIFT (74×74) + NITRO (74×74)
  // No brake button — release-throttle decay + DRIFT (cannon brake) cover it.
  // No backward button — pmndrs's reverse is rarely useful and adds clutter.
  const TURN_SIZE = 84
  const GAS_SIZE = 110
  const SMALL_SIZE = 74
  const SAFE = 16
  const turnGap = 14
  const turnY = Math.max(0, vh - TURN_SIZE - SAFE)
  const gasY = Math.max(0, vh - GAS_SIZE - SAFE)
  const driftX = Math.max(0, vw - GAS_SIZE - SAFE - 12 - SMALL_SIZE)
  const driftY = Math.max(0, vh - GAS_SIZE - SAFE - 8) // align bottom roughly with gas
  const nitroY = Math.max(0, driftY - SMALL_SIZE - 12)

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

      {/* RIGHT — GAS (big) + NITRO + DRIFT */}
      <div data-testid="touch-gas-wrap" style={{ ...containerBase, top: gasY, left: Math.max(0, vw - GAS_SIZE - SAFE) }}>
        <HoldButton
          testid="touch-gas"
          label="油门"
          action="forward"
          style={{
            width: GAS_SIZE,
            height: GAS_SIZE,
            borderRadius: '50%',
            background: 'radial-gradient(circle at 30% 30%, rgba(120,255,200,0.85), rgba(12,80,60,0.95) 70%)',
            border: '2px solid rgba(150,255,200,0.95)',
            color: '#eafff5',
            fontSize: 22,
            fontWeight: 900,
            letterSpacing: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none',
            touchAction: 'none',
            boxShadow: '0 6px 18px rgba(0,0,0,0.5), 0 0 28px rgba(80,255,180,0.35), inset 0 2px 0 rgba(255,255,255,0.2)',
            WebkitTapHighlightColor: 'transparent',
          }}
        />
      </div>
      <div data-testid="touch-drift-wrap" style={{ ...containerBase, top: driftY, left: driftX }}>
        <HoldButton
          testid="touch-drift"
          label="漂移"
          action="brake"
          style={{
            width: SMALL_SIZE,
            height: SMALL_SIZE,
            borderRadius: '50%',
            background: 'radial-gradient(circle at 30% 30%, rgba(255,180,80,0.85), rgba(120,50,0,0.95) 70%)',
            border: '2px solid rgba(255,200,100,0.95)',
            color: '#fff7e0',
            fontSize: 16,
            fontWeight: 900,
            letterSpacing: 1.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none',
            touchAction: 'none',
            boxShadow: '0 5px 14px rgba(0,0,0,0.5), 0 0 22px rgba(255,180,60,0.3), inset 0 2px 0 rgba(255,255,255,0.18)',
            WebkitTapHighlightColor: 'transparent',
          }}
        />
      </div>
      <div data-testid="touch-nitro-wrap" style={{ ...containerBase, top: nitroY, left: driftX }}>
        <HoldButton
          testid="touch-nitro"
          label="氮气"
          action="boost"
          style={{
            width: SMALL_SIZE,
            height: SMALL_SIZE,
            borderRadius: '50%',
            background: 'radial-gradient(circle at 30% 30%, rgba(120,220,255,0.9), rgba(0,60,140,0.95) 70%)',
            border: '2px solid rgba(150,230,255,0.95)',
            color: '#eafaff',
            fontSize: 16,
            fontWeight: 900,
            letterSpacing: 1.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none',
            touchAction: 'none',
            boxShadow: '0 5px 14px rgba(0,0,0,0.5), 0 0 22px rgba(80,200,255,0.35), inset 0 2px 0 rgba(255,255,255,0.18)',
            WebkitTapHighlightColor: 'transparent',
          }}
        />
      </div>
    </>
  )
}
