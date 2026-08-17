# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Isaac is a web-based optical design system inspired by Zemax/OpticStudio. It is an npm-workspaces monorepo. Four packages live under `packages/`, and the React UI is `apps/web`: `@isaac/optical-core` (`packages/optical-core`), the portable optical calculation engine; `@isaac/zemax-io` (`packages/zemax-io`), the reader for `.zmx` lens files; `@isaac/glass-catalog` (`packages/glass-catalog`), the SCHOTT glass data; and `@isaac/three-optics` (`packages/three-optics`), Three.js geometry for the 3D layout. `Architecture.md` is the source of truth for scope and conventions.

## Commands

Requires Node >= 22.6. The **engine packages have no build step** — TypeScript runs directly via Node's `--experimental-strip-types`, and `.ts` files import each other with explicit `.ts` extensions (`allowImportingTsExtensions`). Only `apps/web` is bundled, by Vite, because a browser cannot execute `.ts`.

TypeScript is pinned at the root (`typescript@^7`). Before that pin the repo silently used whatever `tsc` was on the machine; TS 7 also needs `"types": ["node"]` in each engine package's tsconfig, without which `@types/node` is not picked up and every `node:*` import fails to resolve.

- `npm test` — run all workspace tests (root).
- `npm run typecheck` — `tsc --noEmit` across workspaces; the only type-safety gate, since nothing is compiled.
- Run one test file: `node --experimental-strip-types --test packages/optical-core/tests/trace.test.ts`
- Run one package: `npm test --workspace @isaac/zemax-io`
- Run the UI: `npm run dev` from the root (Vite, http://localhost:5173) — a thin alias for `npm run dev --workspace @isaac/web`. `npm run build --workspace @isaac/web` is the only bundling in the repo.
- Tests use the built-in `node:test` runner + `node:assert` — no test framework is installed.
- Cross-package imports (`@isaac/optical-core` from `zemax-io`) work through the workspace symlink; run `npm install` at the root after adding a package so the link exists.

## Architecture

The hard rule (see `Architecture.md`): **`optical-core` must stay independent of React, Next.js, Three.js, browser APIs, and UI.** It must remain runnable from browser JS, Web Workers, WebAssembly, and Node. Concretely, do not use Three.js `Vector3` (or any DOM/framework type) inside the core — it has its own `Vector3`/`Point3` primitives, and the core should stay portable enough to reimplement in WASM. UI/visualization layers talk to the engine only through the `OpticalSystem` data model and `traceRay`.

The core is layered, and imports flow one direction: `geometry` → `model` → `tracing`. `src/index.ts` is the single public barrel; prefer adding to it over deep imports from consumers.

- **geometry/** — pure math: immutable `Vector3`, `Point3`, and `intersectSphericalSurface` (ray/sphere-or-plane intersection in a surface's *local frame*, vertex at origin, axis +Z).
- **model/** — the data model: `Ray` (immutable; `.with(changes)` returns a copy and re-normalizes direction), `Surface`, `Material` (`ConstantMaterial`, `SellmeierMaterial`, `ModelGlassMaterial`, plus `AIR`/`N_BK7`/`MATERIAL_CATALOG`), and `OpticalSystem`.

**`ModelGlassMaterial`** is a glass described the way a patent describes one — `nd` and the Abbe number, optionally `ΔPg,F` — rather than by measured Sellmeier coefficients. It is a two-term expansion in Buchdahl's chromatic coordinate `ω = (λ − λd)/(1 + 2.5(λ − λd))`, with `ν₁`/`ν₂` fixed by `nF − nC = (nd − 1)/Vd` and `nG − nF = Pg,F(nF − nC)`. **It is not OpticStudio's model glass**, whose formula is proprietary and unpublished; do not try to reproduce that one. Accuracy is pinned by `glass-catalog`'s `model-glass-accuracy.test.ts`, which rebuilds all 161 g-line-covered SCHOTT glasses from three numbers each and holds the median drift under 5e-5 and the worst under 5e-4 across 400–700 nm. `normalLinePartialDispersion` is the K7–F2 line (`0.6438 − 0.001682·Vd`); recomputing it from those two glasses' real fits gives `0.6442 − 0.001688·Vd`, which is where the constants are verified.
**`PARAXIAL` surfaces** are ideal thin lenses: a plane that bends rays by the paraxial law and nothing else, used as a placeholder for a lens group not yet designed. Power comes from `focalLength` (φ = 1/f), which is *required* on a `PARAXIAL` surface and rejected on every other type; a radius is refused rather than ignored, since it would be a second, contradictory source of the same power. The real trace applies `n'u' = nu − yφ` to the ray's two transverse **slopes** (`dx/dz`, `dy/dz`), not to its direction cosines — that is what makes the surface *ideal*: a collimated bundle lands at exactly `f·u` however wide the aperture, so the surface contributes first-order power and no aberration. Because f is read as `1/φ`, a paraxial surface between unequal media focuses at `n'·f`; the two readings coincide in air, which is how these surfaces are actually used, and `zemax-io` refuses an immersed one rather than pick a convention.

- **tracing/** — `optics.ts` (`refract`/`reflect`/`angleOfIncidence`), `trace.ts` (`traceRay(system, ray) → RayTraceResult`), `ray-generation.ts` (turns the system's aperture + fields into rays: `generateRay`/`generateRayFan`/`generatePupilGrid`, plus `traceRays`), and `paraxial.ts` (`paraxialTrace`, `paraxialProperties` → EFL/BFD/FFD/image distance/magnification, `withImageAtParaxialFocus`).

### `zemax-io`

Reads `.zmx` files in two stages, so unknown tokens are never guessed at:

- **`document.ts`** — `parseZmxDocument(text)` returns a loss-free `{header, surfaces[], trailer}` of raw records. Surface records are *indented* in files Zemax writes; that indentation is the only cue for where the surface list ends.
- **`import.ts`** — `importZmx(textOrBytes, options)` maps a document onto `OpticalSystem`, returning `{system, warnings, glasses, ignoredTokens, document}`.
- **`decode.ts`** — `decodeZmx(bytes)` handles UTF-16 (BOM or zero-byte sniffing) and UTF-8.

Token semantics: `CURV` is curvature (invert for radius), `DISZ` is thickness (`INFINITY` allowed), `DIAM` is the **semi**-diameter (`0` = no aperture ⇒ `Infinity`), `GLAS` names the medium *after* the surface, `STOP` is a bare flag, `WAVM n λ w` is in **micrometers**, `PWAV` is 1-based, and `FTYP <fieldType> <telecentric> <nFields> <nWaves>` gives the counts that trim the padded `WAVM`/`XFLN`/`YFLN` lists. On a `TYPE PARAXIAL` surface `PARM 1` is the focal length and `PARM 2` is the OPD mode (which moves no ray, so it stays in `ignoredTokens`); any *other* `PARM` there is refused rather than guessed at, and `PARM` counts as handled only on a paraxial surface — elsewhere its meaning is unverified, so it stays reported. Aperture tokens: `ENPD`/`FNUM`/`OBNA`/`FLOA`.

The format has **no public specification** (dropped from the Zemax help system ~2005), so the rule is: interpret only what has been verified against real files, report everything else in `ignoredTokens`, and *refuse* rather than approximate when geometry cannot be modeled (non-`STANDARD` surface types, non-zero `CONI`, `MODE NONSEQ`, unresolved glass unless `allowUnknownGlass`). Glass resolution is injected via `resolveMaterial` — `zemax-io` must not grow its own glass database; that is `glass-catalog`'s job.

**`ignoredTokens` is not a defect list.** A real file carries 30-plus record types that are annotation, not prescription — notes, tolerancing, display flags, multi-configuration, non-sequential and physical-optics settings — so a long list is normal and says nothing about whether the import is right. What matters is separated out into `warnings`: `UNMODELED_SURFACE_TOKENS` (`CLAP`, `SQAP`, `OBDC`, `UDAD`/`USAP`, `PKUP`, `XDAT`/`YDAT`) are the ignored *surface* records that would move a ray, so their presence is warned about per surface; and `warnHeaderSettings` reports vignetting factors (`VDXN`/`VDYN`/`VCXN`/`VCYN`/`VANN`) that are not all zero, ray aiming (`RAIM` ≠ 0, which this reader cannot do — see "Aiming is paraxial"), and an `ENVD` environment away from 20 °C / 1 atm. Each is warned about only when it departs from the no-op value nearly every file carries. Don't add a token to those lists on a guess about its meaning; leave it in `ignoredTokens`. The UI must present the two differently — warnings up front, ignored tokens folded away.

**Model glass.** A `GLAS` record naming `___BLANK` (`MODEL_GLASS_NAME`) describes the glass inline instead of naming it: value 3 is `nd` and value 4 is `Vd`. Match on that name, *not* on the record's flag columns, whose meaning is unverified. **Only those two values are read.** The column where `ΔPg,F` might live is left alone because one file in the sample corpus carries a stray number there that is plainly an unrelated glass's Abbe number left by an edit — so glasses are built on the normal line. `Vd = 0` is not an Abbe number (it would mean infinite dispersion); it means the file gave an index only, so it becomes a `ConstantMaterial`. Both cases are reported once per file in `warnings`, never per surface — a file can carry dozens.

A resolver may answer with a *different* glass (`glass-catalog`'s `allowLegacyNames` maps `SK16` → `N-SK16`). That is an approximation, so `importZmx` compares the returned `material.name` with the file's name — ignoring case and `-`/`_`/space, which are only spelling — and reports the difference once per glass in `warnings` and per surface as `ZmxGlassReference.resolvedAs`.

### `glass-catalog`

`src/schott.ts` is **generated** — never hand-edit it. `npm run regenerate --workspace @isaac/glass-catalog` refetches from the refractiveindex.info database (public domain/CC0, generated from SCHOTT's own Zemax catalog) via `scripts/fetch-schott.ts`.

Only entries published as refractiveindex.info "formula 2" — the three-term Sellmeier `n² − 1 = Σ Bᵢλ²/(λ² − Cᵢ)` that `optical-core` implements — are emitted; 162 of SCHOTT's 171 make it. The 9 skipped ones carry a constant term or are tabulated-only, and the generator lists them in the file header rather than approximating them.

- `SCHOTT` is the ready-made catalog; `GlassCatalog.get(name)` normalizes case and separators (`N-BK7` = `n bk7` = `NBK7`), and construction throws if two names collide once normalized.
- `GlassMaterial.indexAt` **throws outside the published fit range** by default (`{ strictRange: false }` to extrapolate) — a Sellmeier fit far outside its range looks plausible and is meaningless. `nd`/`abbeNumber` throw when the fit misses the F and C lines.
- Obsolete names (`BK7`) resolve only under `{ allowLegacyNames: true }`, which follows SCHOTT's own `N-` convention for lead-free replacements and reports the substitution in `lookup().substitutedFor`. It is off by default because the replacement is not the same glass.
- `catalog.resolver()` returns exactly the function `zemax-io`'s `resolveMaterial` option wants — that is the intended wiring, and `zemax-io` still must not depend on this package.

### `apps/web`

React 19 + Vite. The UI talks to the engine only through `OpticalSystem`, `traceRay`, and the generators — no optical maths lives here.

- **The engine throws by design, so the UI must never assume success.** Every engine call goes through `lib/result.ts` (`attempt()` → `Result<T>`), and each panel is wrapped in an `ErrorBoundary`. A telecentric pupil, an unknown glass, or a wavelength outside a glass's fit range becomes a message in one panel, not a blank screen.
- **State is one immutable `OpticalSystem` plus an undo stack.** Edits call `.with()` / `withSurfaceAt()` and push a new system; `useMemo` keyed on the system re-derives traces only when the design actually changes. `lib/edits.ts` holds the edit operations, each returning `Result<OpticalSystem>` so a rejected edit leaves the previous design on screen.
- **Wavelength is the series dimension**, colored F-blue / d-green / C-red by physics convention. That pairing sits in the 6–8 ΔE band under protanopia, so color is never the only cue: plots also carry dash patterns and marker shapes, and the legend is always present. Layout rays drop the dash when only one wavelength is drawn.
- Plots are hand-drawn SVG (`lib/plot.ts` has the scale and tick helpers); there is no charting dependency.
- **The layout has a 2D and a 3D view**, toggled in the Layout panel. Both take wheel to zoom and a left drag to pan; the 3D view adds a middle-button drag to orbit, which is *not* Three's default mapping (it rotates with the left button) — the two views share a gesture vocabulary deliberately. Each has a reset button, driven by a `resetSignal` counter the views watch. The 2D view pans by rewriting the SVG `viewBox`, so stroke widths scale with the zoom.
- **`Layout3DView` is lazy-loaded.** Three.js and React Three Fiber are ~900 kB of the bundle, and a session that never opens the 3D view should never fetch them. Keep it behind `lazy()`.
- **Colors for WebGL are resolved from `theme.css` at runtime** (`lib/theme-colors.ts`), and re-read when the theme changes — the SVG views hand `var(--wave-blue)` to an attribute and let CSS do it, but a material needs a real value. Don't start a second palette in TypeScript.

### `three-optics`

Three.js geometry for an `OpticalSystem` and nothing else: **no React, no renderer, no browser APIs** — it builds geometry in Node, which is how it is unit-tested. `apps/web` owns the R3F mount and the controls.

- Everything drawn is rotationally symmetric, so a surface is its meridional profile revolved. A glass element is *one* closed `LatheGeometry` running axis → rim along the front surface, across the ground edge, and rim → axis back along the rear; both ends on the axis is what closes the solid rather than leaving open caps.
- `LatheGeometry` revolves about **Y** and the optical axis is **Z**, so every geometry is rotated a quarter turn about X as it is built and comes out already in the engine's frame.
- Rays are the tracer's own 3D intersection points, merged into one buffer of line segments per (wavelength, blocked) group — hundreds of separate line objects would cost far more than the geometry does.
- Geometry is built outside React's reconciler, so `OpticalScene.dispose()` must be called when it is replaced.
- The crossed-element test is the same measurement `lib/layout.ts` makes, so the two views agree about which elements are impossible.

### Conventions that span files

- **Coordinates:** right-handed; optical axis is +Z; sequential rays propagate −Z → +Z. Geometry math happens in each surface's *local frame* (vertex at origin); `trace.ts` converts to/from global coordinates using `OpticalSystem.vertexZAt(i)`.
- **Axial layout:** surface vertex positions are *derived*, not stored per-surface. `OpticalSystem` places surface index 1 (first surface after OBJECT) at z = 0 and accumulates `thickness` forward; the OBJECT surface sits behind at negative z (or −∞ for an object at infinity). A surface's `thickness` is the distance to the *next* surface, and its `material` is the medium *after* it (toward +Z).
- **System invariants:** a system needs ≥ 2 surfaces; first must be `OBJECT`, last must be `IMAGE`. At most one surface may be the stop (`isStop`, `STANDARD` or `PARAXIAL` only), reachable as `OpticalSystem.stopIndex`. Constructors validate aggressively and throw `RangeError`/`TypeError`.
- **Surface geometry:** stored as `radius` (`Infinity` = plane; positive radius ⇒ center of curvature toward +Z); `curvature` is the derived `1/radius`. `semiDiameter` is the clear aperture — rays beyond it are `BLOCKED`.
- **Surface power** is `surfacePower(surface, nBefore, nAfter)` (in `tracing/paraxial.ts`), the single definition of the `φ` in `n'u' = nu − yφ`. Every recurrence goes through it — `paraxialTrace`, both pupil solves, the reversed front-focal-distance trace, and `trace.ts`'s ideal bend — so a new surface type gains power in one place. Power is unchanged by reversing the system, so the backwards traces pass their media in *forward* order rather than flipping a curvature sign.
- **Immutability:** `Ray`, `Surface`, and `OpticalSystem` are all immutable and expose `.with(changes)` (plus `OpticalSystem.withSurfaceAt`) to derive copies. Solves and editor edits return new systems; axial geometry is recomputed in the constructor.
- **Paraxial:** `paraxialTrace` runs the y–u recurrence (`n'u' = nu − yφ`, `y += u't`) starting *at surface 1*, skipping the IMAGE surface. `EFL = −y₁/u'` and `BFD = −y_k/u'`. Mirrors throw — the axial layout assumes forward propagation — and so does a system with no refracting surface.
- **Pupils:** `entrancePupil`/`exitPupil` image the stop through the surfaces before/after it by tracing two rays from the stop (center → location, rim → size). The entrance-pupil solve runs *backwards*, in a reversed frame ζ = −(z − z₁) where curvatures flip sign and the media swap. A pupil may be virtual (behind the stop, or in front of surface 1); a zero exit slope means telecentric and throws.
- **Ray generation:** normalized pupil coordinates `(px, py)` span the entrance pupil (unit circle = rim). Rays are aimed at the solved entrance-pupil plane when the system has a stop, and at surface 1's vertex plane otherwise. All four aperture types work: `ENTRANCE_PUPIL_DIAMETER`, `OBJECT_SPACE_NA`, `IMAGE_SPACE_FNUM` (from the paraxial EFL, infinite conjugate only), and `FLOAT_BY_STOP` (from the stop's semi-diameter). Objects at infinity take `angleDeg` fields and launch from a plane in front of surface 1; finite objects take `objectHeight` fields and launch from the object plane.
- **Aiming is paraxial (first order).** A ray aimed at the pupil rim can miss the stop edge by the residual aberration and come back `BLOCKED` — see the test that pins this. Closing that gap needs iterative *real* ray aiming, which is deliberately not implemented.
- **Ray outcomes:** `traceRay` walks surfaces in order and returns a `RayTraceResult` whose `intersections[]` carry everything a future visualizer needs (points, normals, in/out directions, indices, AoI). Terminal `RayStatus` values: `TERMINATED` (reached IMAGE), `BLOCKED` (aperture), `MISSED` (no intersection), `TIR` (total internal reflection).

## Scope discipline

`Architecture.md` deliberately limits current capabilities to spherical/plane surfaces, Snell refraction, mirror reflection, and sequential tracing. Optimization, tolerancing, diffraction, MTF/PSF, coatings, polarization, non-sequential tracing, and complex aspheres are explicitly **out of scope for now** — don't add them speculatively. Surface types are limited to `OBJECT`/`STANDARD`/`PARAXIAL`/`IMAGE`; `ASPHERIC`/`COORDINATE_BREAK`/`MIRROR` etc. are planned but intentionally absent.
