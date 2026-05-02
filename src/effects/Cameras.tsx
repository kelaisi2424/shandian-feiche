import { PerspectiveCamera, OrthographicCamera } from '@react-three/drei'
import { useStore } from '../store'

export function Cameras() {
  const [camera, editor] = useStore((state) => [state.camera, state.editor])
  return editor ? (
    <OrthographicCamera makeDefault={editor} position={[0, 50, 0]} zoom={20} />
  ) : (
    <>
      {/* V3 D1 T4 → D3 C: chase camera tightened further.
          Pre-V3:    [0, 10,  -20  ]  FOV 75   car ~7% of 390 px
          D1 T4:     [0,  4,   -8.5]  FOV 58   car ~16% of 390 px
          D3 C:      [0,  3.3, -7.6]  FOV 55   car ~21% of 390 px
          Even lower + tighter for "成人方程式" feel, no demo-toy. The
          Vehicle.tsx useFrame still applies sway / engine-tilt offsets
          on top of this base position. */}
      <PerspectiveCamera makeDefault={!editor && camera !== 'BIRD_EYE'} fov={55} rotation={[0, Math.PI, 0]} position={[0, 3.3, -7.6]} />
      <OrthographicCamera makeDefault={!editor && camera === 'BIRD_EYE'} position={[0, 100, 0]} rotation={[(-1 * Math.PI) / 2, 0, Math.PI]} zoom={15} />
    </>
  )
}
