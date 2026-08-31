// Geometry primitives
export { Vector3 } from './geometry/vector3.ts';
export { Point3 } from './geometry/point3.ts';
export { Transform3 } from './geometry/transform3.ts';
export {
  intersectSurface,
  intersectSphericalSurface,
  type SurfaceHit,
} from './geometry/surface-intersection.ts';
export {
  sphericalShape,
  maximumSagRadius,
  surfaceSag,
  surfaceProfileSag,
  surfaceSlopeOverRadius,
  vertexCurvature,
} from './geometry/surface-sag.ts';
export type { SurfaceShape } from './geometry/surface-sag.ts';

// Optical model
export { Ray } from './model/ray.ts';
export type { RayOptions, RayChanges, RayStatus } from './model/ray.ts';
export {
  ConstantMaterial,
  SellmeierMaterial,
  ModelGlassMaterial,
  SchottDispersionMaterial,
  DISPERSION_FORMULA,
  dispersionMaterial,
  SPECTRAL_LINES,
  normalLinePartialDispersion,
  AIR,
  VACUUM,
  N_BK7,
  MATERIAL_CATALOG,
} from './model/material.ts';
export type {
  Material,
  SellmeierCoefficients,
  SchottDispersionCoefficients,
  ModelGlassOptions,
} from './model/material.ts';
export { Surface, ASPHERIC_SURFACE_TYPES, STOP_CAPABLE_SURFACE_TYPES } from './model/surface.ts';
export type { SurfaceConfig, SurfaceType, CoordinateTransform } from './model/surface.ts';
export {
  apertureBlocks,
  apertureClearRadius,
  apertureHalfExtents,
  isCircularAperture,
  isObscuration,
  normalizeAperture,
  CIRCULAR_APERTURE_KINDS,
  OBSCURING_APERTURE_KINDS,
} from './model/aperture.ts';
export type { ApertureKind, SurfaceAperture, SurfaceApertureConfig } from './model/aperture.ts';
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
  signedMediaIndices,
  paraxialTrace,
  paraxialProperties,
  withImageAtParaxialFocus,
  lastRefractingSurfaceIndex,
  entrancePupil,
  entrancePupilPlaneZ,
  stopRadius,
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
