// V3 D3 (A) → V3 D4: multi-condition flip / stuck recovery.
//
// Recovery is the *bottom* layer; the new physics tuning in
// Chassis.tsx + Vehicle.tsx (linearDamping 0.18, angularDamping 0.55,
// box height 1.1 → 0.8, high-speed steer attenuation, low-speed drift
// gate) should keep most laps off the roof. This module handles the
// edge cases where physics still loses.
//
// Three trigger paths, all converging on store.actions.reset() (which
// V3 D4 also re-asserts controls.forward = true so the recovered car
// actually drives away again):
//
//   1. TILT — chassis world-up.y < 0.45 + speed < 8 km/h, held 1 s.
//      Catches genuine roll-over.
//   2. STUCK — controls.forward=true + planar position delta < 1.5
//      units over a 2.5 s rolling window + ready=true. Catches the
//      "wedged into a wall facing forward but going nowhere" case.
//   3. MANUAL — Hud.tsx ↻ button calls actions.reset() directly. Same
//      code path so user complaints converge with auto recovery.
//
// After ANY recovery: 1 s invincibility window where TILT and STUCK
// detection are suppressed (so a wobbly respawn settle doesn't
// immediately re-trigger).
//
// Debug surface (window.__recoverDebug):
//   Read-only:   upY, speed, holdMs, stuckMs, invRemainMs, forwardState
//   Live ref:    api      (cannon useBox PublicApi for the chassis)
//   Test hooks:  forceFlip()   throws a strong angular impulse on the
//                              chassis to simulate a roll-over.
//                forceStuck()  zeroes velocity + holds the chassis in
//                              place for ~3 s so the STUCK detector
//                              fires.
//
// Tuning: window.__recoverTune = { tiltUpY, speedThreshold, holdMs,
//                                  invMs, stuckDelta, stuckMs }

import { addEffect } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Quaternion, Vector3 } from 'three'

import type { PublicApi } from '@react-three/cannon'

import { getState, mutation, useStore } from '../store'

declare global {
  interface Window {
    __recoverTune?: {
      tiltUpY?: number
      speedThreshold?: number
      holdMs?: number
      invMs?: number
      stuckDelta?: number
      stuckMs?: number
    }
    __recoverDebug?: {
      upY: number
      speed: number
      holdMs: number
      stuckMs: number
      invRemainMs: number
      forwardState: boolean
      api: PublicApi | null
      forceFlip: () => void
      forceStuck: () => void
    }
  }
}

const _q = new Quaternion()
const _up = new Vector3()
const WORLD_UP = new Vector3(0, 1, 0)

interface PosSample {
  x: number
  z: number
  t: number
}

export function AutoRecover(): null {
  const chassisBody = useStore((s) => s.chassisBody)
  const reset = useStore((s) => s.actions.reset)
  const tiltStartRef = useRef(0)
  const invUntilRef = useRef(0)
  const stuckBufRef = useRef<PosSample[]>([])
  const forceStuckUntilRef = useRef(0)

  useEffect(
    () =>
      addEffect(() => {
        const tune = (typeof window !== 'undefined' && window.__recoverTune) || {}
        const TILT_UP_Y = tune.tiltUpY ?? 0.45
        const SPEED = tune.speedThreshold ?? 8
        const HOLD_MS = tune.holdMs ?? 1000
        const INV_MS = tune.invMs ?? 1000
        const STUCK_DELTA = tune.stuckDelta ?? 1.5
        const STUCK_MS = tune.stuckMs ?? 2500

        const now = performance.now()

        // Invincibility countdown
        const inv = invUntilRef.current
        const invRemain = inv > now ? inv - now : 0

        // Live chassis state
        const body = chassisBody.current
        let upY = 1
        if (body) {
          body.getWorldQuaternion(_q)
          _up.copy(WORLD_UP).applyQuaternion(_q)
          upY = _up.y
        }
        const speed = mutation.speed ?? 0
        const s = getState()
        const fwd = !!s.controls.forward
        const ready = !!s.ready
        const api = s.api

        // forceStuck() override — pin the chassis in place each frame
        // until the timer expires. STUCK detector should fire well
        // before the timer ends.
        if (forceStuckUntilRef.current > now && api) {
          api.velocity.set(0, 0, 0)
          api.angularVelocity.set(0, 0, 0)
        }

        // Rolling position-progress buffer
        const px = mutation.position[0]
        const pz = mutation.position[2]
        const buf = stuckBufRef.current
        while (buf.length && now - buf[0].t > STUCK_MS) buf.shift()
        buf.push({ x: px, z: pz, t: now })
        let planarDelta = 0
        let windowMs = 0
        if (buf.length >= 2) {
          const dx = buf[buf.length - 1].x - buf[0].x
          const dz = buf[buf.length - 1].z - buf[0].z
          planarDelta = Math.sqrt(dx * dx + dz * dz)
          windowMs = now - buf[0].t
        }

        const tilted = upY < TILT_UP_Y && speed < SPEED
        const stuck = ready && fwd && windowMs >= STUCK_MS && planarDelta < STUCK_DELTA && speed < SPEED * 1.5

        // Always publish debug + test hooks (rebuild each frame so api
        // ref is current — the chassis remounts can swap api).
        if (typeof window !== 'undefined') {
          window.__recoverDebug = {
            upY: +upY.toFixed(3),
            speed: +speed.toFixed(1),
            holdMs: tiltStartRef.current ? +(now - tiltStartRef.current).toFixed(0) : 0,
            stuckMs: +windowMs.toFixed(0),
            invRemainMs: +invRemain.toFixed(0),
            forwardState: fwd,
            api,
            forceFlip: () => {
              const a = getState().api
              if (!a) return
              // Strong roll + yaw impulse — guarantees up.y goes
              // negative within a frame or two.
              a.angularVelocity.set(18, 4, 6)
            },
            forceStuck: () => {
              const a = getState().api
              if (!a) return
              a.velocity.set(0, 0, 0)
              a.angularVelocity.set(0, 0, 0)
              forceStuckUntilRef.current = performance.now() + 3500
            },
          }
        }

        // Suppress detection during invincibility window.
        if (invRemain > 0) {
          tiltStartRef.current = 0
          return
        }

        // Path 1: TILT
        if (tilted) {
          if (!tiltStartRef.current) tiltStartRef.current = now
          if (now - tiltStartRef.current >= HOLD_MS) {
            tiltStartRef.current = 0
            invUntilRef.current = now + INV_MS
            stuckBufRef.current = []
            forceStuckUntilRef.current = 0
            reset()
            return
          }
        } else {
          tiltStartRef.current = 0
        }

        // Path 2: STUCK
        if (stuck) {
          tiltStartRef.current = 0
          invUntilRef.current = now + INV_MS
          stuckBufRef.current = []
          forceStuckUntilRef.current = 0
          reset()
          return
        }
      }),
    [chassisBody, reset],
  )

  return null
}
