import { useEffect, useState } from 'react'
import { Layers } from 'three'
import { Canvas } from '@react-three/fiber'
import { Physics, Debug } from '@react-three/cannon'
import { Sky, Environment, PerspectiveCamera, OrbitControls, Stats } from '@react-three/drei'

import type { DirectionalLight } from 'three'

import { HideMouse, Keyboard, TouchControls } from './controls'
import { AutoRecover, Cameras } from './effects'
import { BoundingBox, Ramp, Track, Vehicle, Goal, Train, Heightmap } from './models'
import { angularVelocity, getState, levelLayer, mutation, position, rotation, useStore } from './store'
import { Checkpoint, Clock, Speed, Minimap, Intro, Help, Editor, LeaderBoard, Finished, PickColor, Hud } from './ui'
import { useToggle } from './useToggle'
import { clearResumeSnapshot, saveResumeSnapshot } from './utils/resume'

const layers = new Layers()
layers.enable(levelLayer)

export function App(): JSX.Element {
  const [light, setLight] = useState<DirectionalLight | null>(null)
  const [actions, dpr, editor, shadows, ready, finished] = useStore((s) => [s.actions, s.dpr, s.editor, s.shadows, s.ready, s.finished])
  const { onCheckpoint, onFinish: rawOnFinish, onStart } = actions

  // V3 D3 (B): wrap onFinish so clearing the resume snapshot is part
  // of the official "race ended" path. Goal.tsx already calls
  // actions.onFinish on collide; we just augment.
  const onFinish = () => {
    rawOnFinish()
    clearResumeSnapshot()
  }

  // V3 D3 (B): periodic 1500 ms snapshot writer. Active only while
  // ready=true and !finished. Reads chassis position from
  // mutation.position / mutation.rotation, which Chassis.tsx keeps
  // in sync via api.position.subscribe / api.rotation.subscribe.
  // (cannon v6's useBox ref doesn't auto-update, so chassisBody.current
  // .position would always be the spawn coord.)
  useEffect(() => {
    if (!ready || finished) return
    const id = setInterval(() => {
      const s = getState()
      saveResumeSnapshot({
        pos: [...mutation.position] as [number, number, number],
        rot: [...mutation.rotation] as [number, number, number],
        speed: mutation.speed,
        boost: mutation.boost,
        elapsedMs: s.start ? Math.max(0, Date.now() - s.start) : 0,
      })
    }, 1500)
    return () => clearInterval(id)
  }, [ready, finished])

  const ToggledCheckpoint = useToggle(Checkpoint, 'checkpoint')
  const ToggledDebug = useToggle(Debug, 'debug')
  const ToggledEditor = useToggle(Editor, 'editor')
  const ToggledFinished = useToggle(Finished, 'finished')
  const ToggledMap = useToggle(Minimap, 'map')
  const ToggledOrbitControls = useToggle(OrbitControls, 'editor')
  const ToggledStats = useToggle(Stats, 'stats')

  return (
    <Intro>
      <Canvas key={`${dpr}${shadows}`} dpr={[1, dpr]} shadows={shadows} camera={{ position: [0, 5, 15], fov: 50 }}>
        {/* V3 D1 T5: cool-night palette. Pre-V3 was warm-orange-desert
            (fog 'white' + Sky default sunPosition baked a peach gradient).
            New: deep navy-purple fog matching a city-night vibe + lower
            sun so the dome trends violet/blue. Heightmap geometry is
            still the canyon mesh — full city-building swap is D3 work. */}
        {/* V3 D3 (C): cooler grading. fog start pulled in 60 → 25 so the
            warm-canyon foreground actually gets blue-shifted by fog;
            directional light tinted cold-blue (#7ea0d0) with dimmer
            intensity, so even the lit faces of rocks read cool instead
            of orange-desert. Ambient bumped slightly so shadow side
            doesn't go pitch black. */}
        <fog attach="fog" args={['#1a1633', 25, 320]} />
        <Sky sunPosition={[-80, -5, 120]} distance={1000} mieCoefficient={0.005} mieDirectionalG={0.9} rayleigh={3} turbidity={12} />
        <ambientLight layers={layers} intensity={0.28} color="#90a8c8" />
        <directionalLight
          ref={setLight}
          layers={layers}
          position={[0, 50, 150]}
          intensity={0.78}
          color="#7ea0d0"
          shadow-bias={-0.001}
          shadow-mapSize={[4096, 4096]}
          shadow-camera-left={-150}
          shadow-camera-right={150}
          shadow-camera-top={150}
          shadow-camera-bottom={-150}
          castShadow
        />
        <PerspectiveCamera makeDefault={editor} fov={75} position={[0, 20, 20]} />
        <Physics allowSleep broadphase="SAP" defaultContactMaterial={{ contactEquationRelaxation: 4, friction: 1e-3 }}>
          <ToggledDebug scale={1.0001} color="white">
            <Vehicle angularVelocity={[...angularVelocity]} position={[...position]} rotation={[...rotation]}>
              {light && <primitive object={light.target} />}
              <Cameras />
            </Vehicle>
            <Train />
            <Ramp args={[30, 6, 8]} position={[2, -1, 168.55]} rotation={[0, 0.49, Math.PI / 15]} />
            <Heightmap elementSize={0.5085} position={[327 - 66.5, -3.3, -473 + 213]} rotation={[-Math.PI / 2, 0, -Math.PI]} />
            <Goal args={[0.001, 10, 18]} onCollideBegin={onStart} rotation={[0, 0.55, 0]} position={[-27, 1, 180]} />
            <Goal args={[0.001, 10, 18]} onCollideBegin={onFinish} rotation={[0, -1.2, 0]} position={[-104, 1, -189]} />
            <Goal args={[0.001, 10, 18]} onCollideBegin={onCheckpoint} rotation={[0, -0.5, 0]} position={[-50, 1, -5]} />
            <BoundingBox {...{ depth: 512, height: 100, position: [0, 40, 0], width: 512 }} />
          </ToggledDebug>
        </Physics>
        <Track />
        <Environment files="textures/dikhololo_night_1k.hdr" />
        <ToggledMap />
        <ToggledOrbitControls />
      </Canvas>
      <Clock />
      <ToggledEditor />
      <ToggledFinished />
      <Help />
      <Speed />
      <ToggledStats />
      <ToggledCheckpoint />
      <LeaderBoard />
      <PickColor />
      <HideMouse />
      <Keyboard />
      <TouchControls />
      <AutoRecover />
      <Hud />
    </Intro>
  )
}
