import { PerspectiveCamera, OrthographicCamera } from '@react-three/drei'
import { useStore } from '../store'

export function Cameras() {
  const [camera, editor] = useStore((state) => [state.camera, state.editor])
  return editor ? (
    <OrthographicCamera makeDefault={editor} position={[0, 50, 0]} zoom={20} />
  ) : (
    <>
      {/* V3 D1: chase camera pulled in for mobile screen-fill.
          Was [0, 10, -20] FOV 75 → car ~7% of 390 px width.
          Now [0, 5.5, -10.5] FOV 64 → car ~13% of 390 px width.
          The Vehicle.tsx parent rotation puts +Z behind the car, so a
          NEGATIVE z position means "behind" the car in the parent frame. */}
      <PerspectiveCamera makeDefault={!editor && camera !== 'BIRD_EYE'} fov={64} rotation={[0, Math.PI, 0]} position={[0, 5.5, -10.5]} />
      <OrthographicCamera makeDefault={!editor && camera === 'BIRD_EYE'} position={[0, 100, 0]} rotation={[(-1 * Math.PI) / 2, 0, Math.PI]} zoom={15} />
    </>
  )
}
