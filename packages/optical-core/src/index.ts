// Geometry primitives
export { Vector3 } from './geometry/vector3.ts';
export { Point3 } from './geometry/point3.ts';
export { intersectSphericalSurface, type SurfaceHit } from './geometry/surface-intersection.ts';

// Optical model
export { Ray } from './model/ray.ts';
export type { RayOptions, RayChanges, RayStatus } from './model/ray.ts';
export {
  ConstantMaterial,
  SellmeierMaterial,
  ModelGlassMaterial,
  SPECTRAL_LINES,
  normalLinePartialDispersion,
  AIR,
  VACUUM,
  N_BK7,
  MATERIAL_CATALOG,
} from './model/material.ts';
export type { Material, SellmeierCoefficients, ModelGlassOptions } from './model/material.ts';
export { Surface } from './model/surface.ts';
export type { SurfaceConfig, SurfaceType } from './model/surface.ts';
export { OpticalSystem } from './model/optical-system.ts';
export type {
  OpticalSystemConfig,
  LinearUnit,
  Field,
  Aperture,
  ApertureType,
} from './model/optical-system.ts';

// Ray tracing
export { refract, reflect, angleOfIncidence } from './tracing/optics.ts';
export { traceRay } from './tracing/trace.ts';
export type { Intersection, InteractionKind, RayTraceResult } from './tracing/trace.ts';
export {
  surfacePower,
  paraxialTrace,
  paraxialProperties,
  withImageAtParaxialFocus,
  lastRefractingSurfaceIndex,
  entrancePupil,
  exitPupil,
} from './tracing/paraxial.ts';
export type {
  ParaxialRayState,
  ParaxialStart,
  ParaxialProperties,
  Pupil,
} from './tracing/paraxial.ts';
export {
  entrancePupilRadius,
  entrancePupilZ,
  imageSpaceFNumber,
  objectDistance,
  isObjectAtInfinity,
  generateRay,
  generateChiefRay,
  generateMarginalRay,
  generateRayFan,
  generatePupilGrid,
  traceRays,
} from './tracing/ray-generation.ts';
export type {
  PupilPoint,
  RayGenerationOptions,
  RayFanOptions,
  PupilGridOptions,
} from './tracing/ray-generation.ts';
