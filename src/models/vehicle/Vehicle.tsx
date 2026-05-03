import { MathUtils, Vector3 } from 'three'
import { useLayoutEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useRaycastVehicle } from '@react-three/cannon'

import type { PropsWithChildren } from 'react'
import type { BoxProps, RaycastVehicleProps, WheelInfoOptions } from '@react-three/cannon'

import { AccelerateAudio, BoostAudio, Boost, BrakeAudio, Dust, EngineAudio, HonkAudio, Skid } from '../../effects'
import { getState, mutation, useStore } from '../../store'
import { useToggle } from '../../useToggle'
import { Chassis } from './Chassis'
import { Wheel } from './Wheel'

import type { Camera, Controls, WheelInfo } from '../../store'

const { lerp } = MathUtils
const v = new Vector3()

type VehicleProps = PropsWithChildren<Pick<BoxProps, 'angularVelocity' | 'position' | 'rotation'>>
type DerivedWheelInfo = WheelInfo & Required<Pick<WheelInfoOptions, 'chassisConnectionPointLocal' | 'isFrontWheel'>>

export function Vehicle({ angularVelocity, children, position, rotation }: VehicleProps) {
  const defaultCamera = useThree((state) => state.camera)
  const [chassisBody, vehicleConfig, wheelInfo, wheels] = useStore((s) => [s.chassisBody, s.vehicleConfig, s.wheelInfo, s.wheels])
  const { back, force, front, height, maxBrake, steer, maxSpeed, width } = vehicleConfig

  const wheelInfos = wheels.map((_, index): DerivedWheelInfo => {
    const length = index < 2 ? front : back
    const sideMulti = index % 2 ? 0.5 : -0.5
    return {
      ...wheelInfo,
      chassisConnectionPointLocal: [width * sideMulti, height, length],
      isFrontWheel: Boolean(index % 2),
    }
  })

  const raycast: RaycastVehicleProps = {
    chassisBody,
    wheels,
    wheelInfos,
  }

  const [, api] = useRaycastVehicle(() => raycast, null, [wheelInfo])

  useLayoutEffect(() => api.sliding.subscribe((sliding) => (mutation.sliding = sliding)), [api])

  let camera: Camera
  let editor: boolean
  let controls: Controls
  let engineValue = 0
  let i = 0
  let isBoosting = false
  let speed = 0
  let steeringValue = 0
  let swaySpeed = 0
  let swayTarget = 0
  let swayValue = 0

  useFrame((state, delta) => {
    camera = getState().camera
    editor = getState().editor
    controls = getState().controls
    speed = mutation.speed

    isBoosting = controls.boost && mutation.boost > 0

    if (isBoosting) {
      mutation.boost = Math.max(mutation.boost - 1, 0)
    }

    engineValue = lerp(
      engineValue,
      controls.forward || controls.backward ? force * (controls.forward && !controls.backward ? (isBoosting ? -1.5 : -1) : 1) : 0,
      delta * 20,
    )
    // V3 D4: high-speed steering attenuation. Pre-D4 the same `steer`
    // value (0.28) was applied at 5 km/h and at 130 km/h, so any sharp
    // input near max speed snapped the car sideways and flipped it.
    // Now scales 1.0 at low speed → 0.35 at high speed.
    const steerSpeedFactor = Math.max(0.35, 1 - Math.min(speed / (maxSpeed * 0.7), 0.65))
    const steerTarget = controls.left || controls.right ? steer * steerSpeedFactor * (controls.left && !controls.right ? 1 : -1) : 0
    steeringValue = lerp(steeringValue, steerTarget, delta * 20)
    for (i = 2; i < 4; i++) api.applyEngineForce(speed < maxSpeed ? engineValue : 0, i)
    for (i = 0; i < 2; i++) api.setSteeringValue(steeringValue, i)
    // V3 D4: low-speed drift gate. Below 18 mph (~30 km/h) the brake
    // key acts as a soft slowdown only (25 % of maxBrake). This stops
    // a stationary or near-stationary car from locking the rear wheels
    // and pivot-flipping when the player taps "漂移". Above the
    // threshold the original full-brake drift behaviour kicks in.
    const driftActive = speed >= 18
    const brakeRaw = controls.brake ? (controls.forward ? maxBrake / 1.5 : maxBrake) : 0
    const brakeForce = controls.brake ? (driftActive ? brakeRaw : maxBrake * 0.25) : 0
    for (i = 2; i < 4; i++) api.setBrake(brakeForce, i)

    if (!editor) {
      if (camera === 'FIRST_PERSON') {
        v.set(0.3 + (Math.sin(-steeringValue) * speed) / 30, 0.4, -0.1)
      } else if (camera === 'DEFAULT') {
        v.set((Math.sin(steeringValue) * speed) / 2.5, 1.25 + (engineValue / 1000) * -0.5, -5 - speed / 15 + (controls.brake ? 1 : 0))
      }

      // ctrl.left-ctrl.right, up-down, near-far
      defaultCamera.position.lerp(v, delta)

      // ctrl.left-ctrl.right swivel
      defaultCamera.rotation.z = lerp(
        defaultCamera.rotation.z,
        (camera !== 'BIRD_EYE' ? 0 : Math.PI) + (-steeringValue * speed) / (camera === 'DEFAULT' ? 40 : 60),
        delta,
      )
    }

    // lean chassis
    chassisBody.current!.children[0].rotation.z = MathUtils.lerp(chassisBody.current!.children[0].rotation.z, (-steeringValue * speed) / 200, delta * 4)

    // Camera sway
    swaySpeed = isBoosting ? 60 : 30
    swayTarget = isBoosting ? (speed / maxSpeed) * 8 : (speed / maxSpeed) * 2
    swayValue = isBoosting ? (speed / maxSpeed + 0.25) * 30 : MathUtils.lerp(swayValue, swayTarget, delta * (isBoosting ? 10 : 20))
    defaultCamera.rotation.z += (Math.sin(state.clock.elapsedTime * swaySpeed * 0.9) / 1000) * swayValue
    defaultCamera.rotation.x += (Math.sin(state.clock.elapsedTime * swaySpeed) / 1000) * swayValue

    // Vibrations
    chassisBody.current!.children[0].rotation.x = (Math.sin(state.clock.getElapsedTime() * 20) * (speed / maxSpeed)) / 100
    chassisBody.current!.children[0].rotation.z = (Math.cos(state.clock.getElapsedTime() * 20) * (speed / maxSpeed)) / 100
  })

  const ToggledAccelerateAudio = useToggle(AccelerateAudio, ['ready', 'sound'])
  const ToggledEngineAudio = useToggle(EngineAudio, ['ready', 'sound'])

  return (
    <group>
      <Chassis ref={chassisBody} {...{ angularVelocity, position, rotation }}>
        <ToggledAccelerateAudio />
        <BoostAudio />
        <BrakeAudio />
        <ToggledEngineAudio />
        <HonkAudio />
        <Boost />
        {children}
      </Chassis>
      <>
        {wheels.map((wheel, index) => (
          <Wheel ref={wheel} leftSide={!(index % 2)} key={index} />
        ))}
      </>
      <Dust />
      <Skid />
    </group>
  )
}
