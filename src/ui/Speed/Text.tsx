import { addEffect } from '@react-three/fiber'
import { useEffect, useRef } from 'react'

import { mutation } from '../../store'

// V3 D1 (T3): convert mph → KM/H. mutation.speed is in mph internally;
// 1 mph ≈ 1.60934 km/h. Multiply at display time only — don't change
// any physics-side speed math (that's all mph + cannon units).
const MPH_TO_KMH = 1.60934
const getSpeed = () => `${(mutation.speed * MPH_TO_KMH).toFixed()}`

export const Text = (): JSX.Element => {
  const ref = useRef<HTMLSpanElement>(null)

  let speed = getSpeed()

  useEffect(() =>
    addEffect(() => {
      if (!ref.current) return
      speed = getSpeed()
      if (ref.current.innerText !== speed) {
        ref.current.innerText = speed
      }
    }),
  )

  return (
    <div className="speed-text">
      <span ref={ref}>{speed}</span> KM/H
    </div>
  )
}
