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

const DPAD_BUTTON_STYLE: React.CSSProperties = {
  width: 64,
  height: 64,
  borderRadius: 14,
  border: '1.5px solid rgba(255,255,255,0.4)',
  background: 'rgba(20,28,48,0.55)',
  color: 'white',
  fontSize: 28,
  fontWeight: 800,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  userSelect: 'none',
  touchAction: 'none',
  boxShadow: '0 4px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.18)',
  WebkitTapHighlightColor: 'transparent',
}

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

  // Anchor the buttons via top/left/right relative to visualViewport
  // dimensions so both real iPhone (vh = innerHeight, vw = innerWidth)
  // and Chromium emulation (mismatched) land them inside the visible
  // 0..vw × 0..vh band.
  const dpadTop = Math.max(0, vh - 220)
  const actionsTop = Math.max(0, vh - 290)
  const dpadLeft = 16
  const actionsRight = 16
  // For the right action stack, compute LEFT instead of using `right`
  // so we don't depend on innerWidth when emulating.
  const ACTIONS_COL_WIDTH = 110 // widest button (GAS = 96) + 14 padding
  const actionsLeft = Math.max(0, vw - ACTIONS_COL_WIDTH - actionsRight)

  const containerBase: React.CSSProperties = {
    position: 'fixed',
    zIndex: 9000,
    pointerEvents: 'auto',
    userSelect: 'none',
    touchAction: 'none',
  }

  return (
    <>
      {/* LEFT D-pad — 3-row + shape */}
      <div
        data-testid="touch-dpad"
        style={{
          ...containerBase,
          top: dpadTop,
          left: dpadLeft,
          display: 'grid',
          gridTemplateColumns: '64px 64px 64px',
          gridTemplateRows: '64px 64px 64px',
          gap: 6,
        }}
      >
        <div />
        <HoldButton testid="touch-up" label="↑" action="forward" style={DPAD_BUTTON_STYLE} />
        <div />
        <HoldButton testid="touch-left" label="←" action="left" style={DPAD_BUTTON_STYLE} />
        <div />
        <HoldButton testid="touch-right" label="→" action="right" style={DPAD_BUTTON_STYLE} />
        <div />
        <HoldButton testid="touch-down" label="↓" action="backward" style={DPAD_BUTTON_STYLE} />
        <div />
      </div>

      {/* RIGHT action stack — GAS / NITRO / DRIFT */}
      <div
        data-testid="touch-actions"
        style={{
          ...containerBase,
          top: actionsTop,
          left: actionsLeft,
          width: ACTIONS_COL_WIDTH,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          alignItems: 'flex-end',
        }}
      >
        <HoldButton
          testid="touch-nitro"
          label="NITRO"
          action="boost"
          style={{
            background: 'linear-gradient(180deg, rgba(38,214,255,0.55), rgba(8,40,90,0.85))',
            border: '1.5px solid rgba(120,220,255,0.85)',
            color: '#eaf6ff',
          }}
        />
        <HoldButton
          testid="touch-drift"
          label="DRIFT"
          action="brake"
          style={{
            background: 'linear-gradient(180deg, rgba(255,212,0,0.6), rgba(120,80,0,0.9))',
            border: '1.5px solid rgba(255,228,90,0.9)',
            color: '#fff7d8',
          }}
        />
        <HoldButton
          testid="touch-gas"
          label="GAS"
          action="forward"
          style={{
            width: 96,
            height: 96,
            background: 'linear-gradient(180deg, rgba(80,255,120,0.55), rgba(20,80,30,0.9))',
            border: '1.5px solid rgba(120,255,160,0.9)',
            color: '#f1ffe6',
            fontSize: 18,
          }}
        />
      </div>
    </>
  )
}
