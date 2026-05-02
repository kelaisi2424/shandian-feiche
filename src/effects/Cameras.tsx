import { PerspectiveCamera, OrthographicCamera } from '@react-three/drei'
import { useStore } from '../store'

export function Cameras() {
  const [camera, editor] = useStore((state) => [state.camera, state.editor])
  return editor ? (
    <OrthographicCamera makeDefault={editor} position={[0, 50, 0]} zoom={20} />
  ) : (
    <>
      {/* V3 D1 T4: pulled chase camera further in for clearer car presence.
          Pre-V3:    [0, 10,  -20  ]  FOV 75   car ~7% of 390 px
          T4 (this): [0,  4,   -8.5]  FOV 58   car ~16% of 390 px
          Lower height + tighter dist + tighter FOV = "車身壓地" feel,
          not "兒童俯視" feel. Vehicle.tsx parent rotation makes -z = behind. */}
      <PerspectiveCamera makeDefault={!editor && camera !== 'BIRD_EYE'} fov={58} rotation={[0, Math.PI, 0]} position={[0, 4.0, -8.5]} />
      <OrthographicCamera makeDefault={!editor && camera === 'BIRD_EYE'} position={[0, 100, 0]} rotation={[(-1 * Math.PI) / 2, 0, Math.PI]} zoom={15} />
    </>
  )
}
