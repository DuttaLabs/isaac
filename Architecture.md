# Isaac — a web-based optical design system

Isaac is a web-based optical design program inspired by Zemax/OpticStudio.

## Why this exists

OpticStudio costs roughly $7,500 per year. That price is fine for industry and
simply not an option for everyone else — students, researchers outside
industry, small labs, independent designers, anyone learning the field. The
goal of Isaac is to replicate **most of what OpticStudio does**, in a modern,
accessible, browser-based tool.

That ambition sets the scope. Isaac is not a toy ray tracer or a teaching demo;
it is meant to become a real optical design program.

### The accepted tradeoff

A web-based system will be substantially slower than a native one, and may
prove too slow to match OpticStudio's power on the largest problems.
**That is an accepted tradeoff.** Accessibility comes first; speed comes
second, and is an engineering problem to be attacked later rather than a reason
to narrow the goal now.

The architecture keeps that door open — see "The performance path" below.

## Core goals

- Modern, user-friendly web interface
- Spreadsheet-style Lens Data Editor
- Three.js 3-D optical visualization
- Sequential optical ray tracing
- Import of publicly available ZEMAX/ZMX files
- Local computation initially
- Ability to move computationally intensive work to a faster runtime, or to a
  server, later

## The one hard rule

**The optical calculation engine must be completely independent of the UI.**

No React, no UI framework of any kind, no Three.js, no DOM or other browser
APIs inside `optical-core`. This is the rule that everything else depends on,
and it is not negotiable.

The engine must remain usable from:

- browser JavaScript
- Web Workers
- WebAssembly
- Node.js
- a future cloud computation service

The UI and visualization layers communicate with the engine **only** through
the optical-system data model and the tracing entry points.

Concretely: do not use Three.js `Vector3` (or any framework or DOM type) inside
the core. It has its own `Vector3`/`Point3` primitives for exactly this reason.

### The performance path

The engine is plain TypeScript today, which is fast enough for interactive
sequential tracing and nowhere near fast enough for optimization, MTF over many
fields, or non-sequential tracing at scale.

The intended escape route is to reimplement the hot numerical core in a
high-performance environment — **Rust compiled to WebAssembly** — and/or to move
heavy runs to a server, while keeping the same data model and API. This is
*why* the independence rule exists: an engine entangled with React could never
make that move.

Anything added to `optical-core` should therefore stay portable: plain data,
deterministic arithmetic, no reliance on JavaScript-specific conveniences in
the numerical paths.

## Scope and priorities

The long-term target is most of OpticStudio's capability. Nothing on the
following list is forbidden or "out of scope" — the list is about **order**, not
permission.

**High priority:**

- Mirrors (reflective surfaces)
- Coordinate breaks (tilts and decenters)
- Conic constants and aspheric surfaces
- Optimization (merit functions, variables, damped least squares)
- MTF
- PSF

**Later, but intended:**

- Non-sequential ray tracing — wanted, but a substantially larger project than
  anything above, and deliberately further down the road
- Tolerancing
- Polarization
- Coatings
- Thermal analysis
- Diffractive, holographic, and gradient-index surfaces
- Additional Zemax-compatible surface types

### The discipline that replaces a scope limit

The scope is broad; the standard is high. A capability lands **complete**
rather than stubbed:

- represented properly in the data model,
- traced correctly, with the first-order/paraxial analysis updated to match,
- covered by unit tests,
- and surfaced in the UI, or explicitly noted as engine-only.

A half-built feature that silently produces wrong numbers is worse than an
absent one, because the UI will happily plot it. Prefer refusing what cannot
yet be modeled — with a clear message — over approximating it.

Mirrors are the cautionary example: `Surface.reflective` exists and `trace.ts`
reflects correctly, but `paraxial.ts` throws on any mirror, so the first-order
analysis cannot describe a system the real tracer handles fine. Finishing that
pairing is part of the mirror work, not a follow-up.

## Current state

Implemented and working:

- `@isaac/optical-core` — geometry, data model, sequential tracing, and
  first-order/paraxial analysis (EFL, BFD, FFD, entrance/exit pupils,
  magnification), plus ray generation from the system's aperture and fields.
- `@isaac/zemax-io` — `.zmx` reader; imports 101 of the 471 OpticStudio sample
  files today, refusing the rest rather than approximating them.
- `@isaac/glass-catalog` — 162 SCHOTT glasses as published Sellmeier fits.
- `@isaac/three-optics` — Three.js geometry for a system; no React, no renderer.
- `apps/web` — React + Vite UI: lens data editor, layout (2D and 3D), ray fans,
  spot diagrams, first-order summary.

Surface types today: `OBJECT`, `STANDARD`, `PARAXIAL`, `IMAGE`. Reflection is a
`reflective` flag on a surface rather than a distinct `MIRROR` type, which
matches how OpticStudio models it (`GLAS MIRROR`).

`CLAUDE.md` is the detailed map of how these packages actually work and the
conventions that span them. This document is the charter: the goals, the hard
rule, and the priorities.

## The optical model

An `OpticalSystem` contains:

- name
- units
- wavelengths, and which one is primary
- fields
- aperture
- surfaces

The object and image surfaces are the first and last entries in `surfaces`,
enforced by invariant, rather than separate members.

A `Surface` has:

- id
- type
- radius (`Infinity` for a plane)
- thickness — the distance to the *next* surface
- semi-diameter
- material — the medium **after** the surface, toward +Z
- reflective flag
- stop flag
- optional comment
- type-specific parameters (e.g. focal length on a paraxial surface)

Axial positions are *derived* from the accumulated thicknesses, not stored per
surface.

## Coordinate convention

Use a right-handed Cartesian coordinate system.

The optical axis is +Z.

Sequential systems normally propagate from negative Z toward positive Z.

A `Ray` has:

- origin: `Point3`
- direction: normalized `Vector3`
- wavelength: nanometers
- intensity
- optical path length
- current medium
- status

## Ray tracing API

The core provides:

    traceRay(system, ray) -> RayTraceResult

`RayTraceResult` contains the final ray, the intersections, and a status. Each
intersection carries enough information for a visualizer to draw the complete
ray path — points, normals, incoming and outgoing directions, indices, and
angle of incidence.

## Design philosophy

Prefer small, composable TypeScript classes and functions.

Keep mathematical calculations deterministic and testable.

Do not mix UI concerns with optical calculations.

Write unit tests for the mathematical portions of the engine.

The engine throws on conditions it cannot model; the UI must never assume
success, and turns a failure into a message in one panel rather than a blank
screen.
