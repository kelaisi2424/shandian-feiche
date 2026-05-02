// V3 D3 (A & B): in-race top-right HUD —
//   ↻   manual reset (calls store.actions.reset(), same path as
//       AutoRecover so user "I'm stuck" complaints converge with the
//       auto-recover path)
//   ⊘   pause + exit to home — writes a resume snapshot then drops
//       ready=false so the splash re-takes the screen
//
// Both buttons:
//   - ≥ 60×60 px tap targets
//   - safe-area-inset-top respected via top: max(16px, env(...))
//   - hidden on splash (only when state.ready is true)

import { getState, useStore, mutation } from '../store'
import { saveResumeSnapshot } from '../utils/resume'

const ICON_BTN: React.CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: '50%',
  border: '1.5px solid rgba(255,255,255,0.35)',
  background: 'rgba(8,14,28,0.6)',
  color: '#cfe0ff',
  fontSize: 24,
  fontWeight: 800,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  userSelect: 'none',
  touchAction: 'manipulation',
  WebkitTapHighlightColor: 'transparent',
  boxShadow: '0 4px 12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.12)',
}

export function Hud(): JSX.Element | null {
  const ready = useStore((s) => s.ready)
  const reset = useStore((s) => s.actions.reset)
  const set = useStore((s) => s.set)

  if (!ready) return null

  const onReset = () => reset()

  const onPauseExit = () => {
    // Snapshot the run before quitting so the home page can offer
    // 继续本局. Reads chassis position/rotation/velocity off the live
    // store; if they're missing (race not really running) we still
    // write a tiny snapshot the home flow can decode-or-discard.
    const s = getState()
    const chassis = s.chassisBody?.current
    let pos: [number, number, number] | undefined
    let rot: [number, number, number] | undefined
    if (chassis) {
      pos = [chassis.position.x, chassis.position.y, chassis.position.z]
      rot = [chassis.rotation.x, chassis.rotation.y, chassis.rotation.z]
    }
    const elapsedMs = s.start ? Math.max(0, Date.now() - s.start) : 0
    saveResumeSnapshot({
      pos,
      rot,
      speed: mutation.speed,
      boost: mutation.boost,
      elapsedMs,
    })
    // Drop `ready` — Intro renders the splash again with a 继续本局 CTA.
    set({ ready: false })
  }

  return (
    <div
      data-testid="race-hud"
      style={{
        position: 'fixed',
        top: 'max(16px, env(safe-area-inset-top))',
        right: 'max(16px, env(safe-area-inset-right))',
        zIndex: 8500,
        display: 'flex',
        gap: 10,
      }}
    >
      <button data-testid="race-reset" aria-label="重置位置" onClick={onReset} style={ICON_BTN}>
        ↻
      </button>
      <button data-testid="race-pause" aria-label="暂停退出" onClick={onPauseExit} style={ICON_BTN}>
        ⏸
      </button>
    </div>
  )
}
