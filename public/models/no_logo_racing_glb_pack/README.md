# No-logo Racing GLB Pack

This pack contains original low-poly/stylized 3D car placeholders for a Three.js racing game.

## Files
- `models/*.glb`: player cars and opponent cars
- `cars_config.json`: car names, tiers, stats, and public paths

## Integration
Copy the `models` folder to your Vite/Three.js project:

```text
public/models/
```

Then load with `GLTFLoader`:

```js
loader.load('/models/lightning_s1.glb', (gltf) => {
  const car = gltf.scene
  car.scale.setScalar(1)
  car.position.set(0, 0, 0)
  scene.add(car)
})
```

## Important
- No real car logos.
- No real brand names.
- Front direction: negative Z.
- Y-up coordinate system.
- These are clean placeholder GLBs, suitable for testing gameplay, garage UI, opponent selection, and racing scene integration.
