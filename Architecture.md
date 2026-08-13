# Web Optical Design System

We are building a web-based optical design program inspired by
Zemax/OpticStudio.

## Core goals

- Modern web interface
- Spreadsheet-style Lens Data Editor
- Three.js 3-D optical visualization
- Sequential optical ray tracing
- Import of publicly available ZEMAX/ZMX files
- Local computation initially
- Ability to move computationally intensive operations to a cloud server later

## Architecture

The optical calculation engine must be completely independent of:

- React
- Next.js
- Three.js
- browser APIs
- UI components

The optical engine must be usable from:

- browser JavaScript
- Web Workers
- WebAssembly
- Node.js
- a future cloud computation service

The UI and visualization layers communicate with the optical engine
through the optical-system data model.

## Initial project structure

packages/
  optical-core/
    src/
      model/
      geometry/
      tracing/
    tests/

Later:

packages/
  zemax-io/
  glass-catalog/
  three-optics/

apps/
  web/

## Initial optical model

An OpticalSystem contains:

- name
- units
- wavelengths
- fields
- aperture
- surfaces
- object definition
- image definition

Surfaces have:

- id
- surface number
- type
- radius
- thickness
- semi-diameter
- material before the surface
- material after the surface
- optional coating
- additional parameters

Initial surface types:

- OBJECT
- STANDARD
- IMAGE

Later:

- ASPHERIC
- COORDINATE_BREAK
- MIRROR
- additional Zemax-compatible surface types

## Coordinate convention

Use a right-handed Cartesian coordinate system.

The optical axis is +Z.

Sequential systems normally propagate from negative Z toward positive Z.

Ray:

- origin: Point3
- direction: normalized Vector3
- wavelength: nanometers
- intensity
- optical path length
- current medium
- status

Do not use Three.js Vector3 inside optical-core.

The core should eventually be portable to WebAssembly or another
implementation.

## Initial optical capabilities

Implement only:

1. rotationally symmetric spherical surfaces
2. plane surfaces where useful
3. refraction using Snell's law
4. reflection where useful
5. ray/spherical-surface intersection
6. sequential ray tracing
7. simple material/refractive-index model

Do NOT implement yet:

- optimization
- tolerancing
- diffraction
- MTF
- PSF
- coatings
- polarization
- non-sequential tracing
- complex aspheres

## Ray tracing API

The core should provide something conceptually equivalent to:

    traceRay(system, ray) -> RayTraceResult

RayTraceResult should contain:

- final ray
- intersections
- status

Each intersection should contain enough information for a future
visualizer to draw the complete ray path.

## Design philosophy

Prefer small, composable TypeScript classes/functions.

Keep mathematical calculations deterministic and testable.

Do not mix UI concerns with optical calculations.

Write unit tests for the mathematical portions of the engine.

The first milestone is:

Create a simple glass lens, launch rays through it, and verify the
ray positions and directions numerically.