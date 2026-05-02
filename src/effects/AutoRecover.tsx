// V3 D3 (A): three-layer flip recovery.
//
// pmndrs's cannon-es vehicle CAN flip — and on the canyon track + the
// new tighter mobile camera the player flips a lot. Pre-D3 the only
// way out was to hit the keyboard 'r' key (no UI, no touch handler),
// which on a phone meant "tab dead, must reload page".
//
// This component adds:
//
//   1. Auto-detect — runs every frame:
//      - chassis world-quaternion → up.y
//      - mutation.speed (km/h)
//      - if up.y < 0.45 (chassis tilted ≥ ~63° away from upright)
//        AND speed < 8 km/h
//        AND condition held continuously for 1.0 s
//        → flip detected
//
//   2. Auto-recover — calls store.actions.reset() (which already
//      teleports back to spawn, zeros velocity + angular velocity,
//      restores full boost) plus sets a 1.0 s "invincibility" window.
//
//   3. Invincibility — for 1 s after recovery, the auto-detect
//      holdtime is forcibly reset on every frame so a quick second
//      flip during the spawn settle can't immediately re-trigger.
//
// Layer 4 (manual ↻ button) lives in Hud.tsx and just calls the
// same store.actions.reset() so the recovery path is identical.

import { addEffect } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Quaternion, Vector3 } from 'three'

import { mutation, useStore } from '../store'

// Tuneable via DevTools: window.__recoverTune = { tiltUpY: 0.45,
// speedThreshold: 8, holdMs: 1000, invMs: 1000 }
declare global {
  interface Window {
    __recoverTune?: {
      tiltUpY?: number
      speedThreshold?: number
      holdMs?: number
      invMs?: number
    }
    __recoverDebug?: {
      upY: number
      speed: number
      holdMs: number
      invRemainMs: number
    }
  }
}

const _q = new Quaternion()
const _up = new Vector3()
const WORLD_UP = new Vector3(0, 1, 0)

export function AutoRecover(): null {
  const chassisBody = useStore((s) => s.chassisBody)
  const reset = useStore((s) => s.actions.reset)
  const tiltStartRef = useRef(0)
  const invUntilRef = useRef(0)
  const lastTickRef = useRef<number>(0)

  useEffect(
    () =>
      addEffect(() => {
        const tune = (typeof window !== 'undefined' && window.__recoverTune) || {}
        const TILT_UP_Y = tune.tiltUpY ?? 0.45
        const SPEED = tune.speedThreshold ?? 8
        const HOLD_MS = tune.holdMs ?? 1000
        const INV_MS = tune.invMs ?? 1000

        const now = performance.now()
        const dt = lastTickRef.current ? now - lastTickRef.current : 0
        lastTickRef.current = now

        // Invincibility: if we just recovered, suppress the tilt timer
        // to avoid an immediate second trigger during spawn settle.
        const inv = invUntilRef.current
        const invRemain = inv > now ? inv - now : 0

        const body = chassisBody.current
        let upY = 1
        if (body) {
          body.getWorldQuaternion(_q)
          _up.copy(WORLD_UP).applyQuaternion(_q)
          upY = _up.y
        }
        const speed = mutation.speed ?? 0
        const tilted = upY < TILT_UP_Y && speed < SPEED

        if (typeof window !== 'undefined') {
          window.__recoverDebug = {
            upY: +upY.toFixed(3),
            speed: +speed.toFixed(1),
            holdMs: tiltStartRef.current ? now - tiltStartRef.current : 0,
            invRemainMs: +invRemain.toFixed(0),
          }
        }

        if (invRemain > 0) {
          // Suppress detection during invincibility.
          tiltStartRef.current = 0
          return
        }

        if (tilted) {
          if (!tiltStartRef.current) tiltStartRef.current = now
          if (now - tiltStartRef.current >= HOLD_MS) {
            // FLIP CONFIRMED → auto-recover
            tiltStartRef.current = 0
            invUntilRef.current = now + INV_MS
            reset()
          }
        } else {
          tiltStartRef.current = 0
        }

        void dt
      }),
    [chassisBody, reset],
  )

  return null
}
