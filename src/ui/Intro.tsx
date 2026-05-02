// V3 D1: stripped of login UI and pmndrs branding for a standalone
// adult-racer voice. Auth + setupSession imports left in main.tsx for
// any backend-side code paths that still reference them, but the
// splash UI no longer offers Google / GitHub sign-in entry points.
import { Suspense, useEffect, useState } from 'react'
import { useProgress } from '@react-three/drei'

import type { ReactNode } from 'react'

import { useStore } from '../store'

export function Intro({ children }: { children: ReactNode }): JSX.Element {
  const [clicked, setClicked] = useState(false)
  const [loading, setLoading] = useState(true)
  const { progress } = useProgress()
  const set = useStore((state) => state.set)

  useEffect(() => {
    if (clicked && !loading) set({ ready: true })
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
          </div>
        </div>
      </div>
    </>
  )
}
