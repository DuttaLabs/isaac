// Three.js geometry for an optical system. Renderer-agnostic and React-free:
// it builds geometry from the engine's data model and nothing else.
export { buildOpticalScene, surfaceProfile } from './scene.ts';
export { aperturePatch, needsAperturePatch } from './aperture-patch.ts';
export type {
  OpticalScene,
  SceneOptions,
  SceneTrace,
  ElementGeometry,
  SurfaceShellGeometry,
  RayBundleGeometry,
} from './scene.ts';
