import { createRoot } from 'react-dom/client'
import { useGLTF, useTexture } from '@react-three/drei'
import 'inter-ui'
import './styles.css'
import { App } from './App'
import { installGestureLockdown } from './utils/disableSelection'
import { initVhUnit } from './utils/vh'

// V3 D2 (P0-2): kill long-press menu / pinch / double-tap zoom / etc.
// Has to run before the first paint so the iOS Safari URL-bar collapse
// doesn't fire its native gestures on game start.
installGestureLockdown()

// V3 D2 (P0-3): iOS Safari 100vh bug fix. Sets a CSS custom property
// --vh = innerHeight × 0.01 px so styles can use `calc(var(--vh) * 100)`
// instead of `100vh` and get the actually-visible height (not the
// pre-collapse layout height).
initVhUnit()

useTexture.preload('/textures/heightmap_1024.png')
useGLTF.preload('/models/track-draco.glb')
useGLTF.preload('/models/chassis-draco.glb')
useGLTF.preload('/models/wheel-draco.glb')

createRoot(document.getElementById('root')!).render(<App />)
