# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Isaac is a web-based optical design system inspired by Zemax/OpticStudio. It is an npm-workspaces monorepo with three packages: `@isaac/optical-core` (`packages/optical-core`), the portable optical calculation engine; `@isaac/zemax-io` (`packages/zemax-io`), the reader for `.zmx` lens files; and `@isaac/glass-catalog` (`packages/glass-catalog`), the SCHOTT glass data. `Architecture.md` is the source of truth for scope, conventions, and the still-planned packages (`three-optics`, `apps/web`).

## Commands

Requires Node >= 22.6. There is **no build/bundler step** — TypeScript runs directly via Node's `--experimental-strip-types`, and `.ts` files import each other with explicit `.ts` extensions (`allowImportingTsExtensions`).

- `npm test` — run all workspace tests (root).
- `npm run typecheck` — `tsc --noEmit` across workspaces; the only type-safety gate, since nothing is compiled.
- Run one test file: `node --experimental-strip-types --test packages/optical-core/tests/trace.test.ts`
- Run one package: `npm test --workspace @isaac/zemax-io`
- Tests use the built-in `node:test` runner + `node:assert` — no test framework is installed.
- Cross-package imports (`@isaac/optical-core` from `zemax-io`) work through the workspace symlink; run `npm install` at the root after adding a package so the link exists.

## Architecture

The hard rule (see `Architecture.md`): **`optical-core` must stay independent of React, Next.js, Three.js, browser APIs, and UI.** It must remain runnable from browser JS, Web Workers, WebAssembly, and Node. Concretely, do not use Three.js `Vector3` (or any DOM/framework type) inside the core — it has its own `Vector3`/`Point3` primitives, and the core should stay portable enough to reimplement in WASM. UI/visualization layers talk to the engine only through the `OpticalSystem` data model and `traceRay`.

The core is layered, and imports flow one direction: `geometry` → `model` → `tracing`. `src/index.ts` is the single public barrel; prefer adding to it over deep imports from consumers.

- **geometry/** — pure math: immutable `Vector3`, `Point3`, and `intersectSphericalSurface` (ray/sphere-or-plane intersection in a surface's *local frame*, vertex at origin, axis +Z).
- **model/** — the data model: `Ray` (immutable; `.with(changes)` returns a copy and re-normalizes direction), `Surface`, `Material` (`ConstantMaterial`, `SellmeierMaterial`, plus `AIR`/`N_BK7`/`MATERIAL_CATALOG`), and `OpticalSystem`.
- **tracing/** — `optics.ts` (`refract`/`reflect`/`angleOfIncidence`), `trace.ts` (`traceRay(system, ray) → RayTraceResult`), `ray-generation.ts` (turns the system's aperture + fields into rays: `generateRay`/`generateRayFan`/`generatePupilGrid`, plus `traceRays`), and `paraxial.ts` (`paraxialTrace`, `paraxialProperties` → EFL/BFD/FFD/image distance/magnification, `withImageAtParaxialFocus`).

### `zemax-io`

Reads `.zmx` files in two stages, so unknown tokens are never guessed at:

- **`document.ts`** — `parseZmxDocument(text)` returns a loss-free `{header, surfaces[], trailer}` of raw records. Surface records are *indented* in files Zemax writes; that indentation is the only cue for where the surface list ends.
- **`import.ts`** — `importZmx(textOrBytes, options)` maps a document onto `OpticalSystem`, returning `{system, warnings, glasses, ignoredTokens, document}`.
- **`decode.ts`** — `decodeZmx(bytes)` handles UTF-16 (BOM or zero-byte sniffing) and UTF-8.

Token semantics: `CURV` is curvature (invert for radius), `DISZ` is thickness (`INFINITY` allowed), `DIAM` is the **semi**-diameter (`0` = no aperture ⇒ `Infinity`), `GLAS` names the medium *after* the surface, `STOP` is a bare flag, `WAVM n λ w` is in **micrometres**, `PWAV` is 1-based, and `FTYP <fieldType> <telecentric> <nFields> <nWaves>` gives the counts that trim the padded `WAVM`/`XFLN`/`YFLN` lists. Aperture tokens: `ENPD`/`FNUM`/`OBNA`/`FLOA`.

The format has **no public specification** (dropped from the Zemax help system ~2005), so the rule is: interpret only what has been verified against real files, report everything else in `ignoredTokens`, and *refuse* rather than approximate when geometry cannot be modelled (non-`STANDARD` surface types, non-zero `CONI`, `MODE NONSEQ`, unresolved glass unless `allowUnknownGlass`). Glass resolution is injected via `resolveMaterial` — `zemax-io` must not grow its own glass database; that is `glass-catalog`'s job.

### `glass-catalog`

`src/schott.ts` is **generated** — never hand-edit it. `npm run regenerate --workspace @isaac/glass-catalog` refetches from the refractiveindex.info database (public domain/CC0, generated from SCHOTT's own Zemax catalogue) via `scripts/fetch-schott.ts`.

Only entries published as refractiveindex.info "formula 2" — the three-term Sellmeier `n² − 1 = Σ Bᵢλ²/(λ² − Cᵢ)` that `optical-core` implements — are emitted; 162 of SCHOTT's 171 make it. The 9 skipped ones carry a constant term or are tabulated-only, and the generator lists them in the file header rather than approximating them.

- `SCHOTT` is the ready-made catalogue; `GlassCatalog.get(name)` normalizes case and separators (`N-BK7` = `n bk7` = `NBK7`), and construction throws if two names collide once normalized.
- `GlassMaterial.indexAt` **throws outside the published fit range** by default (`{ strictRange: false }` to extrapolate) — a Sellmeier fit far outside its range looks plausible and is meaningless. `nd`/`abbeNumber` throw when the fit misses the F and C lines.
- Obsolete names (`BK7`) resolve only under `{ allowLegacyNames: true }`, which follows SCHOTT's own `N-` convention for lead-free replacements and reports the substitution in `lookup().substitutedFor`. It is off by default because the replacement is not the same glass.
- `catalog.resolver()` returns exactly the function `zemax-io`'s `resolveMaterial` option wants — that is the intended wiring, and `zemax-io` still must not depend on this package.

### Conventions that span files

- **Coordinates:** right-handed; optical axis is +Z; sequential rays propagate −Z → +Z. Geometry math happens in each surface's *local frame* (vertex at origin); `trace.ts` converts to/from global coordinates using `OpticalSystem.vertexZAt(i)`.
- **Axial layout:** surface vertex positions are *derived*, not stored per-surface. `OpticalSystem` places surface index 1 (first surface after OBJECT) at z = 0 and accumulates `thickness` forward; the OBJECT surface sits behind at negative z (or −∞ for an object at infinity). A surface's `thickness` is the distance to the *next* surface, and its `material` is the medium *after* it (toward +Z).
- **System invariants:** a system needs ≥ 2 surfaces; first must be `OBJECT`, last must be `IMAGE`. At most one surface may be the stop (`isStop`, `STANDARD` only), reachable as `OpticalSystem.stopIndex`. Constructors validate aggressively and throw `RangeError`/`TypeError`.
- **Surface geometry:** stored as `radius` (`Infinity` = plane; positive radius ⇒ center of curvature toward +Z); `curvature` is the derived `1/radius`. `semiDiameter` is the clear aperture — rays beyond it are `BLOCKED`.
- **Immutability:** `Ray`, `Surface`, and `OpticalSystem` are all immutable and expose `.with(changes)` (plus `OpticalSystem.withSurfaceAt`) to derive copies. Solves and editor edits return new systems; axial geometry is recomputed in the constructor.
- **Paraxial:** `paraxialTrace` runs the y–u recurrence (`n'u' = nu − yφ`, `y += u't`) starting *at surface 1*, skipping the IMAGE surface. `EFL = −y₁/u'` and `BFD = −y_k/u'`. Mirrors throw — the axial layout assumes forward propagation — and so does a system with no refracting surface.
- **Pupils:** `entrancePupil`/`exitPupil` image the stop through the surfaces before/after it by tracing two rays from the stop (centre → location, rim → size). The entrance-pupil solve runs *backwards*, in a reversed frame ζ = −(z − z₁) where curvatures flip sign and the media swap. A pupil may be virtual (behind the stop, or in front of surface 1); a zero exit slope means telecentric and throws.
- **Ray generation:** normalized pupil coordinates `(px, py)` span the entrance pupil (unit circle = rim). Rays are aimed at the solved entrance-pupil plane when the system has a stop, and at surface 1's vertex plane otherwise. All four aperture types work: `ENTRANCE_PUPIL_DIAMETER`, `OBJECT_SPACE_NA`, `IMAGE_SPACE_FNUM` (from the paraxial EFL, infinite conjugate only), and `FLOAT_BY_STOP` (from the stop's semi-diameter). Objects at infinity take `angleDeg` fields and launch from a plane in front of surface 1; finite objects take `objectHeight` fields and launch from the object plane.
- **Aiming is paraxial (first order).** A ray aimed at the pupil rim can miss the stop edge by the residual aberration and come back `BLOCKED` — see the test that pins this. Closing that gap needs iterative *real* ray aiming, which is deliberately not implemented.
- **Ray outcomes:** `traceRay` walks surfaces in order and returns a `RayTraceResult` whose `intersections[]` carry everything a future visualizer needs (points, normals, in/out directions, indices, AoI). Terminal `RayStatus` values: `TERMINATED` (reached IMAGE), `BLOCKED` (aperture), `MISSED` (no intersection), `TIR` (total internal reflection).

## Scope discipline

`Architecture.md` deliberately limits current capabilities to spherical/plane surfaces, Snell refraction, mirror reflection, and sequential tracing. Optimization, tolerancing, diffraction, MTF/PSF, coatings, polarization, non-sequential tracing, and complex aspheres are explicitly **out of scope for now** — don't add them speculatively. Surface types are limited to `OBJECT`/`STANDARD`/`IMAGE`; `ASPHERIC`/`COORDINATE_BREAK`/`MIRROR` etc. are planned but intentionally absent.
