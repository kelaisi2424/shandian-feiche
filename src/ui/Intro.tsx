// V3 D1 + D2 (P0-1, P0-5): WeChat-H5 racing voice splash.
// 点击开始 → ready=true + auto-throttle ON (the car drives itself
// forward; the player only steers + drifts + boosts). No GAS button
// on the in-game HUD because of this. See Touch.tsx for the 4-button
// layout (← / → / 漂移 / 氮气).
import { Suspense, useEffect, useState } from 'react'
import { useProgress } from '@react-three/drei'

import type { ReactNode } from 'react'

import { useStore } from '../store'

export function Intro({ children }: { children: ReactNode }): JSX.Element {
  const [clicked, setClicked] = useState(false)
  const [loading, setLoading] = useState(true)
  const { progress } = useProgress()
  const [set, actions] = useStore((state) => [state.set, state.actions])

  useEffect(() => {
    if (clicked && !loading) {
      set({ ready: true })
      // V3 D2: auto-throttle. The forward control is set true and never
      // released — release-throttle decay isn't a thing the player has
      // to manage. DRIFT (cannon brake) is the only way to slow down,
      // matching the "tap-and-go" voice the spec asks for.
      actions.forward(true)
    }
  }, [clicked, loading])

  useEffect(() => {
    if (progress === 100) setLoading(false)
  }, [progress])

  return (
    <>
      <Suspense fallback={null}>{children}</Suspense>
      <div className={`fullscreen bg ${loading ? 'loading' : 'loaded'} ${clicked && 'clicked'}`}>
        <div className="stack">
          <div className="intro-keys">
            <a className="start-link" href="#" onClick={() => setClicked(true)}>
              {loading ? `载入 ${progress.toFixed()} %` : '点击开始'}
            </a>
            {!loading && <div className="intro-hint">左转 · 右转 · 漂移 · 氮气</div>}
          </div>
        </div>
      </div>
    </>
  )
}
