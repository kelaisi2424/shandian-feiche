// V3 D1 + D2 + D3 (P0-1, P0-5, B): WeChat-H5 racing splash.
// 点击开始 / 继续本局 → ready=true + auto-throttle ON. The car drives
// itself forward; the player only steers + drifts + boosts. See
// Touch.tsx for the 4-button layout (← / → / 漂移 / 氮气).
//
// V3 D3 (B): on first paint we read the resume snapshot
// (utils/resume.ts). If a valid snap exists:
//   - main CTA becomes "继续本局" (and on click, restores chassis
//     position/rotation via store.api after Vehicle has mounted)
//   - secondary CTA "重新开始" clears the snap and starts fresh
// Otherwise the splash shows the normal "点击开始" CTA.
import { Suspense, useEffect, useState } from 'react'
import { useProgress } from '@react-three/drei'

import type { ReactNode } from 'react'

import { getState, useStore } from '../store'
import { clearResumeSnapshot, readResumeSnapshot } from '../utils/resume'
import type { ResumeSnap } from '../utils/resume'

export function Intro({ children }: { children: ReactNode }): JSX.Element {
  const [clicked, setClicked] = useState(false)
  const [loading, setLoading] = useState(true)
  const [resumeSnap, setResumeSnap] = useState<ResumeSnap | null>(null)
  const [resumeMode, setResumeMode] = useState(false)
  const { progress } = useProgress()
  const [set, actions] = useStore((state) => [state.set, state.actions])

  // On mount, look for a valid snapshot (TTL/parse handled by readResumeSnapshot).
  useEffect(() => {
    setResumeSnap(readResumeSnapshot())
  }, [])

  // When the user taps the CTA → ready=true + auto-throttle.
  // If they took the "继续本局" path, restore chassis position once
  // the cannon api is available (Vehicle.tsx writes it on mount).
  useEffect(() => {
    if (!clicked || loading) return
    set({ ready: true })
    actions.forward(true)

    if (resumeMode && resumeSnap) {
      // Defer until Vehicle's chassis api lands in store.api. That can
      // take a frame or two; poll briefly.
      let tries = 0
      const tick = () => {
        const api = getState().api
        if (!api) {
          if (++tries < 60) return requestAnimationFrame(tick)
          return
        }
        if (resumeSnap.pos) api.position.set(...resumeSnap.pos)
        if (resumeSnap.rot) api.rotation.set(...resumeSnap.rot)
        api.angularVelocity.set(0, 0, 0)
        api.velocity.set(0, 0, 0)
        // Roll the in-store start time backward so the displayed clock
        // resumes from where it was. start is Date.now() - elapsedMs.
        if (typeof resumeSnap.elapsedMs === 'number') {
          set({ start: Date.now() - resumeSnap.elapsedMs })
        }
      }
      requestAnimationFrame(tick)
    }
  }, [clicked, loading])

  useEffect(() => {
    if (progress === 100) setLoading(false)
  }, [progress])

  const onStartFresh = () => {
    clearResumeSnapshot()
    setResumeSnap(null)
    setResumeMode(false)
    setClicked(true)
  }
  const onResume = () => {
    setResumeMode(true)
    setClicked(true)
  }

  const showResume = !!resumeSnap && !loading

  return (
    <>
      <Suspense fallback={null}>{children}</Suspense>
      <div className={`fullscreen bg ${loading ? 'loading' : 'loaded'} ${clicked && 'clicked'}`}>
        <div className="stack">
          <div className="intro-keys">
            {showResume ? (
              <>
                <a className="start-link" href="#" onClick={onResume}>
                  继续本局
                </a>
                <a className="start-link start-link-secondary" href="#" onClick={onStartFresh}>
                  重新开始
                </a>
              </>
            ) : (
              <a className="start-link" href="#" onClick={() => setClicked(true)}>
                {loading ? `载入 ${progress.toFixed()} %` : '点击开始'}
              </a>
            )}
            {!loading && <div className="intro-hint">左转 · 右转 · 漂移 · 氮气</div>}
          </div>
        </div>
      </div>
    </>
  )
}
