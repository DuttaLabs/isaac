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
- Run the UI: `npm run dev` from the root (Vite, http://localhost:5173) — `npm run dev --workspace @isaac/web -- --host`. The `--host` binds every interface rather than loopback, so the app is reachable from a phone or tablet on the same network at the LAN URL Vite prints. That also means **anyone on the network can reach the dev server**, which serves out of the project directory — fine at home, not on a shared or public network. Note that a LAN address is not a *secure context* the way `localhost` is, so `showSaveFilePicker` and the Window Management API are absent there: Save falls back to a plain download, which is exactly the fallback path in `lib/save-file.ts`, and the second window is unavailable. `npm run build --workspace @isaac/web` is the only bundling in the repo.
- Tests use the built-in `node:test` runner + `node:assert` — no test framework is installed.
- Cross-package imports (`@isaac/optical-core` from `zemax-io`) work through the workspace symlink; run `npm install` at the root after adding a package so the link exists.

## Architecture

The hard rule (see `Architecture.md`): **`optical-core` must stay independent of React, Next.js, Three.js, browser APIs, and UI.** It must remain runnable from browser JS, Web Workers, WebAssembly, and Node. Concretely, do not use Three.js `Vector3` (or any DOM/framework type) inside the core — it has its own `Vector3`/`Point3` primitives, and the core should stay portable enough to reimplement in WASM. UI/visualization layers talk to the engine only through the `OpticalSystem` data model and `traceRay`.

The core is layered, and imports flow one direction: `geometry` → `model` → `tracing`. `src/index.ts` is the single public barrel; prefer adding to it over deep imports from consumers.

- **geometry/** — pure math: immutable `Vector3`, `Point3`, `surface-sag.ts` (the sag `z(r) = cr²/(1 + √(1 − (1+k)c²r²)) + Σ αᵢr^2i`, plus its slope and vertex curvature) and `intersectSurface` (ray/surface intersection in a surface's *local frame*, vertex at origin, axis +Z). `surface-sag.ts` is the **single definition of surface shape** in the repo — the tracer intersects it, `paraxial.ts` takes its vertex curvature from it, and both layout views draw its profile, so a surface cannot be drawn as one shape and traced as another. `intersectSphericalSurface(o, d, c)` remains as the sphere/plane shorthand.
- **model/** — the data model: `Ray` (immutable; `.with(changes)` returns a copy and re-normalizes direction), `Surface` (which exposes its `shape`, built once in the constructor because the tracer reads it per ray per surface), `aperture.ts` (what stops light at a surface, and the one function that answers it), `Material` (`ConstantMaterial`, `SellmeierMaterial`, `ModelGlassMaterial`, plus `AIR`/`N_BK7`/`MATERIAL_CATALOG`), and `OpticalSystem`.

**`ModelGlassMaterial`** is a glass described the way a patent describes one — `nd` and the Abbe number, optionally `ΔPg,F` — rather than by measured Sellmeier coefficients. It is a two-term expansion in Buchdahl's chromatic coordinate `ω = (λ − λd)/(1 + 2.5(λ − λd))`, with `ν₁`/`ν₂` fixed by `nF − nC = (nd − 1)/Vd` and `nG − nF = Pg,F(nF − nC)`. **It is not OpticStudio's model glass**, whose formula is proprietary and unpublished; do not try to reproduce that one. Accuracy is pinned by `glass-catalog`'s `model-glass-accuracy.test.ts`, which rebuilds all 365 g-line-covered SCHOTT glasses from three numbers each and holds the median drift under 5e-5 and the worst under 5e-4 across 400–700 nm. `normalLinePartialDispersion` is the K7–F2 line (`0.6438 − 0.001682·Vd`); recomputing it from those two glasses' real fits gives `0.6442 − 0.001688·Vd`, which is where the constants are verified.
**`PARAXIAL` surfaces** are ideal thin lenses: a plane that bends rays by the paraxial law and nothing else, used as a placeholder for a lens group not yet designed. Power comes from `focalLength` (φ = 1/f), which is *required* on a `PARAXIAL` surface and rejected on every other type; a radius is refused rather than ignored, since it would be a second, contradictory source of the same power. The real trace applies `n'u' = nu − yφ` to the ray's two transverse **slopes** (`dx/dz`, `dy/dz`), not to its direction cosines — that is what makes the surface *ideal*: a collimated bundle lands at exactly `f·u` however wide the aperture, so the surface contributes first-order power and no aberration. Because f is read as `1/φ`, a paraxial surface between unequal media focuses at `n'·f`; the two readings coincide in air, which is how these surfaces are actually used, and `zemax-io` refuses an immersed one rather than pick a convention.

**Conics and aspheres.** `conic` (the `k` in the sag) lives on any surface that has a radius, and is refused on a `PARAXIAL` one, which is a plane by definition. Aspheric polynomial coefficients need the `EVEN_ASPHERE` type and are refused everywhere else — the same grouping Zemax uses, and for the same reason: a conic is a change of *shape*, a polynomial is a change of *kind*. Trailing zeros are trimmed from `asphericCoefficients`, so "no polynomial" has one spelling and the tracer's closed-form path is taken whenever it applies; interior zeros stay, because they are positions in the series.

Two things about this are easy to get wrong, and both are pinned by tests:

- **`α₁` carries power.** It multiplies r², the same power the base curvature contributes, so the curvature a paraxial ray sees is `c + 2α₁` — `Surface.paraxialCurvature`, which is what `surfacePower` reads. Reading the power off `curvature` would quietly mis-report the focal length of any surface with a non-zero first coefficient, and two of the sixteen even-asphere surfaces in OpticStudio's samples have one. The **conic constant, by contrast, never affects first order**: every conic of a given vertex curvature has the same second-order shape, which is exactly why a conic corrects aberration without disturbing the layout.
- **The normal's orientation follows the *vertex* curvature**, `c + 2α₁`, not the base radius. The project's convention is the sphere's — outward from the center of curvature — while the sag gradient points along +Z, and the two differ by a sign when the center lies toward +Z. The same parabola can be written as a conic on a curved base or as a polynomial on a flat one, so a rule reading `curvature` alone would hand back opposite normals for two spellings of one surface. Refraction and reflection are indifferent to the sign, so this governs what a consumer of `Intersection.normal` sees, not the trace.

The intersection runs in two stages. The conic base is a quadric — `c(x² + y² + (1+k)z²) − 2z = 0` — so it is a closed-form quadratic, solved with the numerically stable root formula because the textbook one loses the small root to cancellation on near-axial rays, which is every ray in a well-behaved system. The polynomial terms are added by Newton iteration from that exact conic hit. Non-convergence, or an iterate wandering off the surface, returns `null` and reads as `MISSED` — the honest report for a ray that cannot be brought onto the surface, and better than a point that is merely near it.

**Mirrors.** `Surface.reflective` makes a surface reflect instead of refract, matching how OpticStudio models one (`GLAS MIRROR`) rather than adding a `MIRROR` type. Everything that makes mirrors work follows from one idea: **the refractive index is signed by the direction the light is going** — positive while it runs −Z → +Z, negative after an odd number of reflections. `signedMediaIndices(system, λ)` is that array, and it is the only thing the paraxial layer needed. A mirror becomes an ordinary surface across which the index goes `n → −n`, so its power falls out of the usual formula as `(−n − n)c = −2nc`, and the recurrence, both pupil solves and the reversed front-focal trace all run unchanged.

The other half is the **axial layout, which needed nothing at all**: a thickness after a mirror is *negative*, being the distance to the next surface measured along +Z when +Z is now behind the light. `OpticalSystem` already accumulated thicknesses into vertex positions, and that plain running sum is already right. It is also the convention every `.zmx` file is written in, which is why the reader needs no coordinate machinery either.

Consequences worth knowing:

- **A mirror cannot change the medium**, and `OpticalSystem` refuses one that claims to. The paraxial layer takes the magnitude from the medium before, so it would ignore a wrong value, but `trace.ts` reads `material` directly for the index the *next* surface refracts from — so a Mangin mirror mislabeled AIR would trace as though the glass vanished on the way back out, and still draw a plausible spot diagram. `zemax-io` fills this in with `adoptMirrorMedia`, since a file never states it.
- **EFL and BFD are negative after an odd number of mirrors.** That is not a bug: image space genuinely runs backwards, and it is the same fact as the negative thickness. Two mirrors turn it round again, which is why a Newtonian's focal length is negative and a Cassegrain's is not. Isaac's own Hubble test pins EFL = 57.6 m at f/24.

  **But the mirror count is not the only thing in that sign, and an even count does not guarantee a positive EFL.** `EFL = −y₁/u′`, so anything that flips the final slope flips the sign — including a beam that crosses the axis *inside* the system. A Cassegrain's secondary sits before the prime focus, so the beam never crosses and the image is inverted; a **Gregorian's sits beyond it**, so the beam crosses once, the image comes out erect, and the focal length is negative with two mirrors. Zemax's `Unobscured Gregorian` reports EFFL = −1237.63 mm and Isaac agrees to the last digit; `mirrors.test.ts` pins it, because a negative focal length on a two-mirror telescope reads as a bug and is not one.
- **An ideal `PARAXIAL` lens must be bent with the sign of travel.** A converging lens converges whichever way the light goes, but a slope is measured against +Z and does not know that, so `bendIdeally` applies `−travel·yφ`. Without it an ideal lens after a mirror diverges — and still traces, and still draws.
- **Anything measuring one surface against the next has to measure along the light**, not along +Z. The crossed-element test in `lib/layout.ts` and `three-optics` takes a travel sign from `signedMediaIndices` for exactly this reason; without it every reflecting arm is reported as self-intersecting.



**Coordinate transforms.** A `COORDINATE_TRANSFORM` surface is not a surface: it has no shape, no glass, no
aperture, and meets no ray. Its whole content is a change of frame for everything after it — the
decenter and tilt that make a fold mirror, a tilted element, or a decentered group possible. The
model refuses anything that would give it optical behavior (a radius, a conic, an aperture, a stop,
a mirror flag), and refuses one that claims to change medium, for the same reason a mirror is
refused: `trace.ts` walks back past transforms to find the medium a ray crossed, so a wrong value would
be ignored by the trace and believed by everything else.

The generalization that made this work is **`OpticalSystem` holding a chain of rigid frames rather
than a list of z coordinates**. `poseAt(i)` is a `Transform3` (`geometry/transform3.ts` — a rotation
matrix and a translation, inverse by transpose) taking a surface's local frame into global
coordinates. The walk is two compositions per surface: a transform re-points the frame, then the
thickness advances along whatever axis the frame now has. A system with no transforms comes out as the
plain running sum of thicknesses it always was, which is why nothing about centered systems changed.

Two coordinates now differ, and confusing them is the easy mistake:

- **`poseAt(i)` / `vertexZAt(i)` are where a surface really is.** Drawing wants these.
- **`axialPositionAt(i)` is how far along the axis it is**, unfolded — the running sum of
  thicknesses, blind to tilts. The first-order layer wants this, because *the paraxial properties of
  a folded system are those of its unfolded equivalent*: a transform has no power, and bending the axis
  does not change the distance measured along it. `paraxial.ts` and `ray-generation.ts` use it.

`OpticalSystem.isCentered` says which case a system is in, and the First Order panel says so on
screen — first-order optics describes one straight axis, so on a folded system those numbers
describe the unfolded equivalent. Exactly right for a fold mirror, where the tilts cancel; an
approximation once an element is genuinely tilted.

**Conventions, all verified against the manual and a real file** (`Short course/Archive/
sc_newtonian3.zmx`, a Newtonian whose diagonal folds the beam out to the eyepiece):

- Tilts are **degrees, right-handed about the positive axes**, relative to the previous surface's
  frame. The order flag matters and both values are in the corpus: false (the file's `0`, 155 of
  185 transforms) decenters first, then tilts about x, the *new* y, the *new* z — composing as
  `Rx·Ry·Rz`. True reverses both halves, and is what lets one transform exactly undo another by negating
  all five numbers. There is a test on that round trip, because it is the property the whole
  three-surface fold idiom rests on.
- **Mirrors needed nothing added.** A fold is a transform, a mirror, and a transform; the thickness after
  the mirror is negative exactly as it always was, and turns positive again after a second
  reflection. The Newtonian above is written that way and imports with no coordinate machinery
  beyond the frame chain.
- **The clear aperture is radial about the surface's own axis**, not the global one — otherwise
  decentering an element would vignette it by its own decenter.
- The tracer `continue`s past a transform, so it contributes no `Intersection`. A consumer counting
  interactions will not see it, which is correct: nothing happened there.

In the corpus, 54 files carry 185 transforms, all sequential. **Tilt about x dominates (105 of them)**,
which is why the 2-D meridional view can draw these properly: a tilt about x keeps the fold in the
y–z plane that view is already in. The sagittal and end-on views cover the rest — a decenter or a
tilt that leaves the meridional plane is invisible in it by definition, and showing itself somewhere
is the whole point of having the other two. Both layout views draw surfaces in their poses and skip transforms
entirely; the 3-D view builds each lathe about the surface's own axis and carries it into place with
a `Matrix4`, and declines to weld an element into one solid when a transform sits between its two faces.

- **tracing/** — `optics.ts` (`refract`/`reflect`/`angleOfIncidence`), `trace.ts` (`traceRay(system, ray) → RayTraceResult`), `ray-generation.ts` (turns the system's aperture + fields into rays: `generateRay`/`generateRayFan`/`generatePupilGrid`, plus `traceRays`), and `paraxial.ts` (`paraxialTrace`, `paraxialProperties` → EFL/BFD/FFD/image distance/magnification, `withImageAtParaxialFocus`).

### `zemax-io`

Reads `.zmx` files in two stages, so unknown tokens are never guessed at:

- **`document.ts`** — `parseZmxDocument(text)` returns a loss-free `{header, surfaces[], trailer}` of raw records. Surface records are *indented* in files Zemax writes; that indentation is the only cue for where the surface list ends.
- **`import.ts`** — `importZmx(textOrBytes, options)` maps a document onto `OpticalSystem`, returning `{system, warnings, glasses, ignoredTokens, document}`.
- **`decode.ts`** — `decodeZmx(bytes)` handles UTF-16 (BOM or zero-byte sniffing) and UTF-8.

Token semantics: `CURV` is curvature (invert for radius), `DISZ` is thickness (`INFINITY` allowed), `DIAM` is the **semi**-diameter (`0` = no aperture ⇒ `Infinity`), `GLAS` names the medium *after* the surface, `STOP` is a bare flag, `WAVM n λ w` is in **micrometers**, `PWAV` is 1-based, and `FTYP <fieldType> <telecentric> <nFields> <nWaves>` gives the counts that trim the padded `WAVM`/`XFLN`/`YFLN` lists. On a `TYPE PARAXIAL` surface `PARM 1` is the focal length and `PARM 2` is the OPD mode (which moves no ray, so it stays in `ignoredTokens`); any *other* `PARM` there is refused rather than guessed at. On a `TYPE EVENASPH` surface `PARM 1`–`PARM 8` are the aspheric coefficients, and **`PARM 1` is the coefficient on r², not r⁴** — Chapter 14 gives the sag as `α₁r² + α₂r⁴ + … + α₈r¹⁶` and maps the eight parameter columns straight onto α₁…α₈, so the series starts at the second power. Reading it as r⁴ would shift every term by one power, and the result would still trace and still look like a lens while being the wrong lens. On a `TYPE COORDBRK` surface `PARM 1`–`PARM 6` are decenter x, decenter y, tilt about x, y and z, and the order flag; `PARM 6` is a *flag*, so any non-zero value means "tilt first", and it is compared that way rather than tested against 1. Outside those three types `PARM`'s meaning is unverified, so it stays in `ignoredTokens`. `CONI` is the conic constant and is read onto the surface. A `COORDBRK` surface names no glass either, and `adoptMirrorMedia` gives it the medium before it for the same reason it does a mirror — Zemax shows "-" in that column to say a transform cannot be a boundary between two media. `GLAS MIRROR` is not a glass at all: it makes the surface reflective and leaves the medium alone, so the reader takes that medium from the surface before — never stated in the file, and wrong as AIR for a mirror inside glass. `UNIT`'s first value spells meters `METER`; no file in the corpus writes `M`. **System** aperture tokens: `ENPD`/`FNUM`/`OBNA`/`FLOA`. **Surface** aperture tokens: `CLAP min max` is a circular clear aperture, `OBSC min max` a circular obscuration, `SQAP xwid ywid` and `SQOB xwid ywid` the rectangular pair, `ELAP xwid ywid` and `ELOB xwid ywid` the elliptical pair, `FLAP` a floating aperture whose radius is the semi-diameter, and `OBDC xdec ydec` decenters whichever of them the surface carries. **`xwid` is a half-width**, which the manual does not say and the corpus settles: `SQAP 25 25` sits on a surface whose semi-diameter is 35.36, exactly 25√2 — the circle circumscribing that rectangle. Reading them as full widths would halve every such aperture and still trace. All four are verified against Chapter 29's keyword table; the files write an undocumented **third** value on the first three, `0` in all 820 records in the corpus, so it is left alone and written back as the `0` everything else writes. A surface may carry more than one — the first is taken and the rest reported. A record with a **zero max radius** (`OBSC 0 0 0`, in one sample file) is an aperture of no extent: reported and ignored, rather than refused or honored.

The format has **no *current* public specification** (dropped from the Zemax help system ~2005), but a pre-2005 one survives: **Chapter 29 of the 2000 Zemax manual** in `SupportingMaterial/` (gitignored) is a full keyword table, and Chapter 14 gives the per-surface-type `PARM` column meanings. Its argument *orders* still match all 471 OpticStudio sample files; it predates later additions, so it is stale on argument *counts* (`WAVM`, the extended `FTYP`/`UNIT`). Check it before inferring a token's meaning — and note that several tokens lead with a placeholder, so `firstValue()` is only correct for single-argument records (`RAIM`'s first value is a dead `tol` field, not the aiming mode). Beyond what it covers, the rule stands: interpret only what has been verified against real files, report everything else in `ignoredTokens`, and *refuse* rather than approximate when geometry cannot be modeled (surface types outside `STANDARD`/`PARAXIAL`/`EVENASPH`, `MODE NONSEQ`, unresolved glass unless `allowUnknownGlass`). Glass resolution is injected via `resolveMaterial` — `zemax-io` must not grow its own glass database; that is `glass-catalog`'s job.

**`ignoredTokens` is not a defect list.** A real file carries 30-plus record types that are annotation, not prescription — notes, tolerancing, display flags, multi-configuration, non-sequential and physical-optics settings — so a long list is normal and says nothing about whether the import is right. What matters is separated out into `warnings`: `UNMODELED_SURFACE_TOKENS` (`SPID`, `UDAD`/`USAP`, `PKUP`, `XDAT`/`YDAT`) are the ignored *surface* records that would move a ray, so their presence is warned about per surface; and `warnHeaderSettings` reports vignetting factors (`VDXN`/`VDYN`/`VCXN`/`VCYN`/`VANN`) that are not all zero, ray aiming (`RAIM` ≠ 0, which this reader cannot do — see "Aiming is paraxial"), and an `ENVD` environment away from 20 °C / 1 atm. Each is warned about only when it departs from the no-op value nearly every file carries. Don't add a token to those lists on a guess about its meaning; leave it in `ignoredTokens`. The UI must present the two differently — warnings up front, ignored tokens folded away.

**Model glass.** A `GLAS` record naming `___BLANK` (`MODEL_GLASS_NAME`) describes the glass inline instead of naming it: value 3 is `nd` and value 4 is `Vd`. Match on that name, *not* on the record's flag columns, whose meaning is unverified. **Only those two values are read.** The column where `ΔPg,F` might live is left alone because one file in the sample corpus carries a stray number there that is plainly an unrelated glass's Abbe number left by an edit — so glasses are built on the normal line. `Vd = 0` is not an Abbe number (it would mean infinite dispersion); it means the file gave an index only, so it becomes a `ConstantMaterial`. Both cases are reported once per file in `warnings`, never per surface — a file can carry dozens.

A resolver may answer under a *different name* than the file used. `importZmx` cannot know why — `resolveMaterial` hands back a material, not a provenance — so it compares the returned `material.name` with the file's name (ignoring case and `-`/`_`/space, which are only spelling) and reports the difference once per glass in `warnings` and per surface as `ZmxGlassReference.resolvedAs`, **without claiming what kind of difference it is**. With `glass-catalog` wired in this now never fires for a SCHOTT name: the catalog holds the manufacturer's retired names too, so a file naming `BK7` traces `BK7`.

**Writing.** `exportZmx(system, options)` (`src/export.ts`) is the reader run backwards, in the same
two stages: `systemToZmxDocument` maps the model onto records, `formatZmxDocument` renders records to
text. **What it writes is what Isaac models.** A file that came *in* carried thirty-odd record types
the reader does not interpret, and none of them are on `OpticalSystem` to write back — so exporting an
imported file reproduces the same *lens*, not the same *file*. Re-emitting an original's untouched
records is a real feature and a different one; the UI says so on every save rather than letting an
export pass for a copy.

Verified against **Chapter 29's keyword table and its "minimum ZMX file"**, and against the record
forms and orderings the 471 sample files actually use. Where the two disagree the corpus wins,
because the manual predates the format's later additions: it spells fields `XFLD`/`YFLD` and
wavelengths `WAVL`, and **no file in the corpus writes either** — they are `XFLN`/`YFLN` and `WAVM`,
which is also what this package reads. Chapter 29 is where `GLAS name code pu nd vd …` was confirmed
column for column (code 0 fixed, 1 model), and `DIAM val solvecode pusurf` likewise.

The guarantee is pinned by **round-tripping the whole corpus**: all 196 sample files Isaac can read,
written out and read back, give an identical system — every surface, glass, field, wavelength and
aperture. That check lives outside the repo (the corpus is gitignored); `tests/export.test.ts` pins
the same property on the fixture and on hand-built systems covering mirrors, transforms, aspheres,
paraxial surfaces, model glasses and all four aperture types.

Three decisions worth keeping:

- **No `VERS` record.** All 471 files open with one and the manual defines it as "the version number
  of ZEMAX that created the file" — which Isaac is not, and inventing a build number is exactly the
  plausible-looking lie this project refuses elsewhere. The manual's own minimum file carries no VERS
  either. Provenance goes in `NOTE`, where it is true. **This is the first thing to try if
  OpticStudio ever refuses a written file** — round-tripping through Isaac's own reader is verified,
  round-tripping through OpticStudio is not.
- **Boilerplate is written at its no-op value.** `GFAC`, `RAIM`, `SDMA`, `ROPD`, `PICB`, `POLS`,
  `GLRS`, `ENVD`, the vignetting rows: records every file carries and this reader ignores. Omitting
  them is defensible, but a reader expecting them would fill in defaults that are not knowable from
  here; writing the value that means "nothing unusual" is the one choice that cannot surprise. They
  are the same no-op values `warnHeaderSettings` checks for on the way in.
- **`exportZmx` returns `{ text, warnings }`**, mirroring `importZmx` — the writer reports what the
  file cannot hold exactly for the same reason the reader does. It fires on one thing today: a model
  glass with a **partial-dispersion deviation**. ΔPg,F *is* written, into the `pd` column the manual
  documents, because dropping a real number silently is worse than writing one this package will not
  read back — the reader leaves that column alone on purpose. So another program gets the glass the
  designer specified, reopening it here puts the glass back on the normal line, and the asymmetry is
  said out loud instead of hidden.
- **`GCAT` is the caller's to name.** A material carries its name but not the catalog it came from,
  and `zemax-io` must not grow a glass database to find out — so the catalogs are a `glassCatalogs`
  option. `apps/web` derives them from `GLASS_CATALOG_NAMES`, itself derived from the records rather
  than listed, so a file can never name a library the app does not resolve against.

Two things are refused rather than approximated: a system **mixing angle fields with object-height
fields** (a file has one field type for the whole system, and a silent choice would read half the
fields back in the wrong unit), and a **field count padded up from zero** — a system arrives with no
fields when the reader could not express the file's, and writing one on-axis field to fill the gap
would turn "Isaac does not know this system's fields" into "this system is on-axis".

### `glass-catalog`

`src/schott.ts` and `src/ohara.ts` are **generated** — never hand-edit them. `npm run regenerate --workspace @isaac/glass-catalog` rebuilds both from the makers' own Zemax-format catalogs in `SupportingMaterial/` (gitignored) via `scripts/build-catalogs.ts`. Adding a manufacturer is a row in that script's `CATALOGS` table plus an export in `index.ts`; the reader is not vendor-specific, because the format is not.

**A manufacturer's `.AGF` is the only source of glass data in this repo.** An earlier version pulled SCHOTT from refractiveindex.info; that is gone deliberately, and a third-party transcription must not come back. The makers' own files are also much larger — **SCHOTT ships 366 entries where that database carried 171** — because they include the glasses no longer made, which is exactly what an old lens file names. Ohara's `OHARA_260701.AGF` holds **433**, matching OpticStudio's Ohara library glass for glass; the `_CATALOG` file they also publish is a 166-glass subset of current production and is *not* what Isaac reads. Vendor files vary in encoding — Ohara ships one plain and one UTF-16 — so the generator decodes with `zemax-io`'s `decodeZmx`, the same problem solved once.

**Each catalog is reproduced entry for entry, duplicates included.** `BK7` and `N-BK7` are both present and carry the same dispersion; they are separate *products* whose optical properties coincide, and their records differ in other ways already (`BK7` is valid over 310–2325 nm and marked `OBSOLETE`, `N-BK7` over 300–2500 nm and `PREFERRED`). Mechanical data that differs between them — thermal expansion, density, chemical resistance — is in the same AGF records and can be added to `GlassRecord` later. **So there is no alias table and no rename tracking**: a name is either in the manufacturer's catalog or it is not. An earlier design aliased retired names onto current ones; keeping the manufacturer's list intact deleted that machinery outright.

**Dispersion is per glass, not per catalog.** `GlassRecord.formula` carries the equation its coefficients belong to, numbered the way the AGF numbers it, and `optical-core`'s `dispersionMaterial(name, formula, coefficients)` is the single place that maps one onto a `Material`:

- `DISPERSION_FORMULA.SELLMEIER_1` (2) — `n² − 1 = Σ Bᵢλ²/(λ² − Cᵢ)`, 365 of the 366 glasses. Note the catalog writes the coefficients **interleaved** `B₁ C₁ B₂ C₂ B₃ C₃`, not grouped.
- `DISPERSION_FORMULA.SCHOTT` (1) — `n² = a₀ + a₁λ² + a₂λ⁻² + a₃λ⁻⁴ + a₄λ⁻⁶ + a₅λ⁻⁸`. Do not read the name as "the formula SCHOTT glasses use": in SCHOTT's own catalog exactly one glass carries it (**B270**, which is why it was implemented), while **188 of Ohara's 433 do** — 43% of the next catalog through the door. The formula is a property of the fit, not of the maker.

Any other formula number is **refused**, not approximated. The gaps (3 Herzberger, 4 Sellmeier 2, 5 Conrady, …) are real numbers left unimplemented because no glass in the catalog uses them; adding one is a case in `dispersionMaterial`. Reading a fit under the wrong formula still returns plausible indices, so the formula number must travel with the coefficients — there is a test on exactly that.

- `SCHOTT` and `OHARA` are the ready-made per-maker catalogs, and **`ALL_GLASSES` is the one a lens file wants** — a `.zmx` names a glass, not the catalog it came from, so `apps/web` resolves against all makers at once. Combining them throws if two makers share a name once normalized, which is the right failure: the file would be ambiguous and picking a winner silently traces someone else's glass. None is shared between SCHOTT's 366 and Ohara's 433 today. `GlassCatalog.get(name)` normalizes case and separators (`N-BK7` = `n bk7` = `NBK7`), and construction throws if two names collide once normalized. Nothing else about a name is guessed at.
- `GlassMaterial.indexAt` **throws outside the published fit range** by default (`{ strictRange: false }` to extrapolate) — a fit far outside its range looks plausible and is meaningless, and the Schott formula, a power series with no poles, misbehaves more quietly out there than a Sellmeier fit does. `nd`/`abbeNumber` throw when the fit misses the F and C lines.
- **The generator refuses to write a fit it cannot reproduce.** The AGF prints `nd` and `Vd` on each glass's `NM` record independently of the coefficients, so rebuilding both from the fit and comparing catches a column read wrongly or a fit handed to the wrong equation. All 799 glasses across both makers pass, and both values are kept on the record (`record.nd`, `record.abbeNumber`) as the datasheet numbers a designer quotes. This gate is also what *verified* the formula numbering: 188 Ohara glasses reproducing their printed values through the Schott formula is not a coincidence.
- `record.status` is the catalog's own, `STANDARD` / `PREFERRED` / `OBSOLETE` / `SPECIAL` / `MELT` — the order the OpticStudio manual lists, which is where those codes were verified rather than assumed. Vendors differ in how they apply them (SCHOTT uses 1–3, Ohara 0–2), and the manual says so, so treat status as a shelf-availability hint. Discontinued glasses are kept — a lens file from 1985 names them — but the UI should rank an available glass first.
- `catalog.resolver()` returns exactly the function `zemax-io`'s `resolveMaterial` option wants — that is the intended wiring, and `zemax-io` still must not depend on this package.

### `apps/web`

React 19 + Vite. The UI talks to the engine only through `OpticalSystem`, `traceRay`, and the generators — no optical maths lives here.

- **The engine throws by design, so the UI must never assume success.** Every engine call goes through `lib/result.ts` (`attempt()` → `Result<T>`), and each panel is wrapped in an `ErrorBoundary`. A telecentric pupil, an unknown glass, or a wavelength outside a glass's fit range becomes a message in one panel, not a blank screen.
- **State is one immutable `OpticalSystem` plus an undo stack.** Edits call `.with()` / `withSurfaceAt()` and push a new system; `useMemo` keyed on the system re-derives traces only when the design actually changes. `lib/edits.ts` holds the edit operations, each returning `Result<OpticalSystem>` so a rejected edit leaves the previous design on screen.
- **Which dimension gets color depends on the view.** In the ray-fan and spot panels the series is **wavelength**, colored F-blue / d-green / C-red by physics convention (`lib/wavelengths.ts`). In the layout it is the **field** (`lib/fields.ts`): a layout is a spatial picture and the bundles are what a reader separates, each leaving at its own angle and landing at its own height, so wavelength moves to the dash pattern there. The 3-D view has no dash to give, so it shows the field alone and its wavelength legend is suppressed rather than naming a cue that is not drawn.
- **Neither palette relies on hue alone.** F-blue/d-green/C-red sits in the 6–8 ΔE band under protanopia, so the plots also carry dash patterns and marker shapes. The six field hues are steps from the same validated ramps, in a fixed order chosen so the first three — which cover all but a handful of real designs — are also the three that clear 3:1 on the light surface, and so the two hues the first-order overlay uses come last. A design with more fields than hues shares one neutral rather than repeating a color, which would say two fields are the same thing. The **field legend is always present**, down to a single field: the wavelength one still hides below two series, but cycling shows the fields one at a time deliberately, and the legend is then the only thing naming which one is on screen — it used to vanish exactly when it was most wanted.
- **A field's color follows its index in the system, never its position among the fields being drawn.** Otherwise unchecking one in the Display column repaints all the others.
- **A mirror is typed where the glass goes**, as `MIRROR` in the Material column — Zemax's own spelling, and the natural place, since the column answers "what happens here". `setMirror` moves two things at once: the medium becomes the medium before the surface (the model refuses anything else), and the thickness changes sign, because otherwise the rest of the design sits where no light goes and every ray comes back `MISSED`. Only that one thickness is flipped, and the editor says so in the status line rather than doing a second, untyped edit silently.
- **The parameter column has one meaning per surface type**, which is Zemax's own arrangement and for the same reason: an `EVEN_ASPHERE` opens its eight coefficients there, a `COORDINATE_TRANSFORM` its decenters and tilts, and giving each type its own columns would leave most of them empty on every row. A break also blanks the cells it cannot carry — radius, conic, semi-diameter, and the Material column, which shows "-" because a transform takes the medium before it and an editable blank would only invite a rejected edit.
- **An aperture is a picture, and the picture is of the part.** The Aperture column sits between
  Label and Radius — an aperture is a fact about the surface rather than about its shape — and holds
  an icon: white is empty space, a colored glyph is the surface itself in its element's color, and a
  black one is something put in the way. The glyph is the aperture's own shape — a circle, a
  rectangle or an ellipse — **at the aperture's own aspect ratio**, so a slit reads as a slit; what is
  not kept is absolute scale, since the icon has nothing to be a proportion of but itself. So the Hubble's primary reads as a mirror with a hole
  down the middle and its baffle as a small disc hanging in the beam. The other reading, where white
  means "light passes", is equally defensible and inverts every icon; this one is what a designer sees
  looking at the hardware, which is what makes a column of them scannable. A floating aperture's rim
  is dashed, because it has no radius of its own. A surface with no aperture gets a faint dashed
  square rather than an empty cell — an empty cell in a column of pictures reads as a missing picture,
  and the outline is also the invitation to click.

  Clicking opens a `<dialog>` with the type, the two radii and the two decenters, editing live like a
  table cell — the same arrangement, and the same reasons, as the aspheric coefficients. Changing the
  *type* keeps the radii, so trying an obscuration against an aperture is one click each way; changing
  to floating drops them, because the model refuses a radius on one.

  **Both layout views draw the hole.** In 2-D a holed surface is stroked as two runs of the same
  outline with the middle left out (`SurfaceProfile.hole` is where, as indices into the samples the
  bounds and the stop bars still read); end-on it is a second rim. A rectangular or elliptical
  aperture reaches a different distance along x than along y, so `Disc` carries two radii and the
  end-on rim takes its **sag per sample** from each point's own distance to the axis — on a circle
  centered on the axis that is one number, which is what the first version relied on, and on any
  other rim it is not. In 3-D the lathe starts at the hole
  radius instead of the axis, so a holed element comes out as the tube it is rather than a disc — and
  because such a profile no longer closes on the axis, the two faces are not welded into one solid,
  for the same reason a transform between them is not.

- **A surface's shape is two columns and a window.** Radius and conic sit side by side, because together they are the shape: the radius is where it starts, the conic is how it departs from a sphere. The eight aspheric coefficients would be eight more columns, pushing radius, thickness and glass off the side of the screen for numbers that are set once and then optimized — so the table keeps one cell summarizing the series and the terms live in a `<dialog>` (`AsphericCoefficients.tsx`). `showModal()` is what makes it modal; the `open` attribute gives no focus trap, no backdrop, and no Escape. Editing there is live, exactly like a table cell, so the layout and plots follow along behind the open dialog.
- Plots are hand-drawn SVG (`lib/plot.ts` has the scale and tick helpers); there is no charting dependency.
- **Cycling the fields** (the button under the Display column) shows the checked fields one at a time, 750 ms each, so a bundle can be told from its neighbours when several cross. It drives the Display checkboxes themselves, so the row shows which field is up — which is why `App` holds the selection to put back when it stops. It ends on the button (restoring), on the design changing underfoot (the saved flags no longer line up), or on a checkbox the user clicks mid-cycle (keeping what is on screen, since that is what they just edited). The button is only *disabled* below two checked fields: cycling leaves one checked, so a live-count guard would let it switch on and then refuse to switch off.
- **Which fields the layout draws is a view setting, not part of the design.** The Display checkboxes in the Source panel live in `App` state, never on `OpticalSystem`: hiding a field to see past it must not land on the undo stack or be written back into a lens file. Hiding one costs its rays rather than just their visibility — `computeLayoutTraces`/`computeVolumeTraces` take the field list, so nothing is traced for a field that is not drawn. The flags are moved by `ListEditor` at the row that knows *which* row was removed, because reconciling two lists by length afterwards silently re-points them at their neighbours; `App` then pads with "visible" as a safety net for systems arriving from a file, an undo, or Reset. Only the layout is affected — the ray-fan and spot panels have their own field selector.
- **The first-order overlay is a teaching aid**, and its two rays are chosen, not arbitrary: the *marginal* ray from the **axial** field through the pupil **rim** (the ray that meets the aperture — it sets the F/# and where the image lies), and the *chief* ray from the **outermost** field through the pupil **center** (the ray that meets the field — it sets the image height). Together they bound the beam, and where each crosses the axis is a pupil or an image. Drawn only at the primary wavelength, because first-order optics has no color in it. The pupil planes are drawn at the radius the *beam* fills (`entrancePupilRadius`), not at the stop image's (`entrancePupil().radius`) — those differ when a design's stop is bigger than its declared aperture, and drawing the larger one would put the marginal ray in the middle of the pupil it is supposed to define. It also draws the **principal planes** `P` and `P′`, which `paraxialProperties` now reports as `frontPrincipalPlaneZ`/`rearPrincipalPlaneZ` — they fall straight out of the focal distances, since `F' = P' + EFL` and `F = P − EFL`. They are the planes a focal length is measured *from*, and on a real lens they are almost never where a beginner would guess: usually inside the glass, sometimes outside it, and crossed over on a strongly asymmetric design. They wear plain ink rather than a hue of their own — everything else in the overlay is somewhere light goes, and a principal plane is pure bookkeeping.

The marginal ray is also **produced undeviated from its first contact to the pupil plane** (`pupilAim` in `lib/layout.ts`, dashed, with a dot at the crossing): the pupil is usually a virtual image of the stop lying inside the glass or behind it, so no real ray ever reaches it, and the incoming ray continued straight is what defines it — and what shows the acceptance angle. Nothing is produced when the pupil sits in front of the glass, since the traced ray already passes through it. Offered only in the 2D view, so the checkbox never promises something the 3D view does not draw.
- **The 2-D layout draws one of three planes**, chosen in the Layout header: **Y–Z** (meridional — the default, and what a lens layout has always meant), **X–Z** (sagittal), and **X–Y** (end-on, looking back along the axis). `lib/view-plane.ts` is the single definition, and a plane there is nothing but its two screen axes; the third is *derived* as right × up, which fixes both which axis it is and whether it runs toward the viewer or away. Writing that down by hand would be a second, contradictable source for the same fact. Because the drawing is no longer always y–z, a `LayoutPoint` is `{h, v}` — horizontal and vertical *in the view* — rather than `{z, y}`, which outside the meridional view they are not.

  Three things genuinely differ between the planes, and all three are read off the `ViewPlane` rather than branched on by name:

  - **A fan has to be spread along the plane it is drawn in.** A ray fan is a flat sheet: the meridional fan lies in y–z, so seen sagittally every one of its rays lies flat on the axis and the picture is a lens with a single line through it. `computeLayoutTraces` takes a `fanAxis` for exactly that, and the view chooses it. End-on *no* fan works, so the X–Y view is filled with the same pupil grid the 3-D view traces — which is what a footprint wants anyway.
  - **End-on a surface has no cross-section**, only a rim. Its outline is the rim circle taken at the rim's own sag, so a tilted surface projects to the ellipse it really is; the profile is marked `closed`, no glass body is built (the glass between two rims is edge-on, and filling the rim would claim the whole aperture is solid), and the stop is marked by stroking its rim rather than by bars hung off two ends a closed curve does not have. The optical axis is a *point* there, so it is drawn as crosshairs.
  - **The drawing box takes its height from the panel.** `WIDTH` is a constant, so a stroke width or a font size means the same thing at every panel size; there is no matching `HEIGHT` — the box's height is measured from the SVG's own screen box and the viewBox follows it. It used to be a constant 340, which froze the drawing's proportions at 900:340 forever: a layout turned on its side is *tall*, and closing every panel underneath it bought nothing at all, because the drawing could only ever be as tall as its width allowed. `.plot-stage` is `flex: 1 1 0` so it takes the free height, which also pushes the legends to the bottom of the panel rather than leaving them stranded under a short drawing.

    The measurement is a `ResizeObserver` on the SVG, taken from **the element's own window** — a divider dragged or a neighbour closed changes the shape with no re-render to hang a measurement on, and an observer built from the global `window` never reports on an element in the second window. Refitting on a new shape follows the same rule as the 3-D camera: yes until the user has framed something with the wheel or a drag, and after that only Reset view.

  - **A plane can be turned on screen, and a turn is not a change of plane.** `quarterTurns` (0–3, clockwise) is a per-pane setting beside the plane, and one quarter turn stands the axis upright with the object at the top and the image at the bottom — how a microscope's column is read. It is applied to the *projected* point, inside `LayoutView`'s `project`, and never by swapping the plane's axes: `layout.ts` reads `view.vertical` to decide which way a surface profile is swept, and a rotated plane would quietly sweep every profile in the wrong direction. Folding it into the projection also means everything drawn through it comes round together — including the first-order overlay, which builds its own points from a z and a radius rather than from `projectToPlane`.

    Three things then have to follow the turn rather than assume a direction, and each was a fixed screen direction before: the **optical axis line**, which stands upright at 90° and 270°; the overlay's **end caps and labels**, which sit across a bar whose direction is now taken from the bar itself; and the **gizmo**, whose axes are turned by `turnAxes`. That last one carries the sign trap — a `ProjectedAxis` is in screen coordinates where `y` grows *downward*, so its turn is the mirror of a `LayoutPoint`'s, and getting it backwards draws a gizmo that contradicts the picture beside it. An in-plane turn cannot change which way the *third* axis points, so `toward` is left alone; there is a test on that.

    **The 3-D view has no equivalent and should not grow one.** Orbiting already reaches every orientation, so the same control there would be a camera roll — and `camera.up` is what `OrbitControls` takes its poles from, so rolling it changes what dragging does.

  - **The first-order overlay is meridional only.** The marginal and chief rays are defined through the fields, and fields are y heights and y angles, so both lie in y–z; anywhere else they would be a line on the axis or a single dot. The checkbox is hidden outside Y–Z for the same reason it is hidden in 3-D — a control must not promise something that does not happen.

- **The orientation gizmo** (`components/AxisTriad.tsx`) says which way the picture is turned, and **both layouts use the same one**. X red, Y green, Z blue — the convention every CAD tool and Three.js itself uses.

  Its rule is the vector notation, not a fake camera angle. An axis lying in the screen is an arrow drawn along the direction it really has; an axis pointing *through* the screen has no length to draw and gets a circle instead — with a **dot** when it comes at you, which is the tip of the arrow, and a **cross** when it goes away, which is the flights at its tail. Nothing is tilted or foreshortened to make the third axis visible: a 2-D view is a 2-D view, and turning the gizmo's camera a few degrees to open that axis out would draw an orientation the picture beside it does not have.

  The two layouts differ only in where the projection comes from, which is why one component serves both:

  - `viewPlaneAxes(plane)` (in `lib/view-plane.ts`) — two axes exactly along the screen's own directions, the third with zero screen length and `toward` taken from `plane.outward.sign`.
  - `cameraAxes(quaternion)` (in `lib/camera-axes.ts`) — the world axes rotated into camera coordinates. A camera in Three looks down its own **−Z**, so screen-right is `x`, screen-up is `y`, and how much of the axis comes *at* the viewer is `z`. Reverse that last sign and the gizmo draws a dot where a cross belongs, which is a picture that is confidently, silently inside out — hence the tests that pin it from two known camera positions.

  So in 3-D the glyph is not a special case anyone wrote: orbit until an axis is within ~12° of the view direction (`EDGE_ON`) and it becomes ⊙ or ⊗ on its own, which is exactly when an arrow would have stopped meaning anything. The other two are then within 12° of the screen plane, so the picture never degenerates into three stubs.

  In 2-D the gizmo is pinned to the corner of the *visible* area, computed from the `viewBox` because that is what panning moves, and scaled by the zoom — a legend that grows when you zoom in has stopped being one. In 3-D it is an SVG laid over the canvas rather than geometry inside it: it is a legend, so it belongs in the same medium as the 2-D one, and ⊙/⊗ is a 2-D symbol that would have to be faked in three dimensions. It is fed by a `useFrame` inside the canvas that publishes through a **ref to the gizmo's own setState**, not up through props — a setter called on the parent would re-render the whole scene on every frame of an orbit, and what actually changed is nine SVG elements. It takes no pointer events: the corner of the canvas is as good a place to start an orbit as any other, and a small dead patch there would be a puzzle.

- **A panel's settings live on its pane** (`lib/panel-settings.ts`), and `Pane.settings` is where they
  sit in the tree. Three things follow, and each is why it is done this way:

  - Two copies of an output panel are independent **without anything keeping them apart**, because
    they are reading different objects. There is no synchronization to write and none to get wrong.
  - Saving the arrangement saves them **for free**, since they are inside the tree that gets saved. A
    layout reopening with its panels in the right places but every plot back at its default would not
    be the layout that was saved.
  - Each panel derives what it draws **inside itself**, keyed on its own settings. `App` used to hold
    one `useMemo` per trace for the whole app, which is why every copy drew the same picture; it also
    had to gate each on whether the panel was on screen anywhere, and a component that exists only
    while its pane does answers that by existing. So `openPanels` is gone.

  A **setting** is something worth reopening with. A *signal* is not — a Reset-view counter is local
  state in the panel, and writing one to disk would mean nothing on the way back in.

  `settingsOf(stored, defaults)` merges rather than trusting, which is what will make a stored layout
  survive Isaac growing a setting: an older one lacks the key and takes the default. Settings whose
  `panel` does not match are discarded outright.

- **Fields are filtered at two levels, and they answer different questions.** The Source panel's
  Display column says which fields are in play **for the whole system** — it is an input panel, so
  every copy of it agrees. `PlotFieldFilter`, laid over each layout's top-left corner, **narrows** that
  for one picture, so two layouts side by side can show one field each and be read against each other.
  It cannot widen: a field off in Source is off everywhere.

  Top-left because the orientation gizmo has the top-right in both views. **Collapsed by default**,
  unlike the gizmo, and the difference is instructive: the gizmo takes no pointer events because the
  corner of a picture is as good a place as any to start a drag, and a checkbox cannot ignore the
  pointer. A field Source has switched off is **ghosted rather than dropped**, the same rule the
  context menus follow.

  The 2-D view gets a `.plot-stage` wrapper to position the overlay in; **the 3-D view must not**. Its
  `.layout-3d` is already the positioned box the gizmo hangs in, and it is `flex: 1 1 0` precisely so
  R3F measures the panel — a box around it, sized by its content, restores exactly the loop that
  leaves the canvas at its untouched 300 × 150. So `Layout3DView` takes an `overlay` prop instead.

- **The Text panel reads files; it does not edit the design.** It opens with two documents supplied
  by `App`: the `.zmx` the design came from — its *original text*, kept on `App` beside the filename —
  and `Current design.zmx`, the live `exportZmx` output, rebuilt on every change so it is always what
  Save would write. Those two differ, and the difference is the point: a file carries thirty-odd
  record types the reader does not interpret, and putting what came in beside what Isaac models is
  the fastest way to see which is which.

  **The syntax colors are the reader's own answer.** `zemax-io` exports `zmxTokenRole`, built from the
  very sets `importZmx` dispatches on, and the highlighter asks it per token. So a record colored as
  prescription is one the importer genuinely reads, a red one is a record that *would* move a ray and
  is not modeled (`SPID`, `UDAD`), and a muted one is annotation. A second list of keywords kept in
  the UI would drift from the reader within a release; this one cannot.

  A `.zmx` is **read-only**, and so the highlighted documents are exactly the read-only ones. That
  makes the editing story simple rather than clever: an editable document is a plain `<textarea>`,
  with no transparent-text-over-highlighted-`<pre>` illusion to keep aligned across fonts and zoom
  levels. The textarea is sized to its content (`rows`) so the box around it does the scrolling and
  the line-number gutter stays beside the right line.

  Ctrl-F is bound to the panel's own subtree rather than the document, so two Text panels do not
  fight over it and it does not fire while the lens grid has focus. Font, size, line numbers and wrap
  are per-pane settings and ride along in the saved layout; **which file is open is not**, and
  deliberately — a layout that reopens with the look it was left in is right, one that reopens
  claiming a file it has not read from disk since yesterday is not. That is what the recent list is
  for (`lib/recent-files.ts`): the names live in `localStorage` and the `FileSystemFileHandle`s live
  in IndexedDB, which is the only store that will take them, and a handle is what lets an entry
  reopen a file rather than merely name it. Where the File System Access API is missing the handles
  are absent and the list is a history — said in the UI rather than hidden.

- **Every analysis is a panel of its own.** The ray fan and the spot diagram were one Analysis panel
  drawing both in a grid, which meant two fans at different fields — the arrangement a fan is actually
  read in — were impossible. As panes they resize against each other, close separately, and can each
  be turned over to something else. It is also what makes the analyses still to come cheap: a new plot
  type is another entry in `PANELS`, and the dropdown offers it with nothing else changed.

- **Every row is numbered, with no exceptions.** The Surface column shows a surface's own number —
  the object is 0 and the image is whatever the last one comes to, which is how a `.zmx` refers to
  them and how Zemax numbers them. Zemax also *names* three of those rows in that column, `OBJ`,
  `STO` and `IMA` (the 2000 manual, Chapter 4: "the object surface, denoted OBJ on the left edge, the
  stop, denoted STO, and the image plane, denoted IMA"), and each name costs that row the one thing
  the column is for. Isaac says both instead: the ends are named in the **Element column** as `OBJ`
  and `IMG`, and the stop keeps its **own column**, moved to sit third — right after Element and
  before Surface Type. Which surface is the stop is a fact about the *system*, like the row's number
  and the element it belongs to, and it was the one such fact stranded past the glass at the far end
  of a table that has to be scrolled sideways.

  `IMG` rather than Zemax's `IMA` because that cell is in Isaac's own Element column, which Zemax does
  not have; the Surface column, which is Zemax's, carries the number.

  Those two are **`SystemEnd`s, not elements** (`lib/elements.ts`): single surfaces rather than pieces
  of glass, each with a name fixed by position and a color of its own. They share `ElementStyles`
  because it is already keyed by surface id and **their ids are ones no gap can claim** — the walk in
  `findElements` starts past the object, and the last surface can only ever be a gap's *back* face, so
  neither id is ever a gap key. There is a test on exactly that, because a collision would silently
  give one thing two owners.

  Their default colors sit deliberately **outside `ELEMENT_PALETTE`** — an end is not glass and should
  not wear a glass color — and they are drawn through their own `endColorsBySurface` map rather than
  being merged into `elementColorsBySurface`: that map is read *by body*, and the 2-D view strokes a
  profile for every surface including the faces of a lens, so one combined map would quietly paint
  every lens face in its body's color.

  One consequence of the span rule: an element's `rowSpan` can reach the image row — a lens whose rear
  face *is* the image plane is a system the model allows — and IMG then has no cell of its own rather
  than a second one fighting for the same square.

- **The object plane is drawn when it has somewhere to be.** Both views used to start at surface 1
  with a comment saying the object sits at −∞; that is true at an infinite conjugate and false at a
  finite one, where the rays already start from a plane that was the one thing missing from the
  picture. `Number.isFinite(system.vertexZAt(0))` is the test — at infinity there is no pose to build
  geometry on. Drawing it is also what makes the OBJ color a real control rather than a swatch with
  nothing to paint.

- **An element is derived, never stored.** The model has a list of surfaces and no notion of a lens:
  a surface's `material` is the medium *after* it, so a piece of glass is *implied* by a surface whose
  following medium is not air together with the next drawn surface. `lib/elements.ts` reads exactly
  that, which is the same rule `layout.ts` uses to fill a cross-section and `three-optics` uses to
  revolve a solid — so the elements the table names are the ones both views draw, and a color chosen
  against one lands on the other.

  **A run of glass is one element with several *gaps*.** A cemented doublet is three surfaces with
  glass across both, and one thing you can pick up — so it is one element spanning three rows, with a
  name of its own. But the two halves are different glasses, and both views already draw them as two
  bodies, so each gap is colored separately and the cell carries **one square swatch per gap**.
  `elementColorsBySurface` is therefore keyed by *surface*: a body is identified by its front surface,
  and that is what lets a doublet's halves be told apart.

  A `COORDINATE_TRANSFORM` is skipped when looking for faces — it carries the medium before it, so
  left in the walk it would look like the middle of a piece of glass — but it is still *covered* by
  the span, because a tilted rear face is written exactly that way.

  **A mirror in air is an element too** (`kind: 'MIRROR'`), and comes out of the same walk. It is one
  surface, one row, no gaps: there is no glass in it and no body to fill, so both views draw it as the
  surface it is. What decides it is the medium — a reflecting surface with air across it is a mirror
  on its own, and one with *glass* across it is a **Mangin mirror**, the silvered back of a solid,
  which goes on being part of the run it reflects in. One test does for both sides, because
  `OpticalSystem` refuses a mirror that changes medium: the medium after it *is* the medium before it.

  **Lenses and mirrors are numbered apart** — L1, L2 … and M1, M2 … — so dropping a fold mirror
  between two lenses does not renumber the lenses. `ordinal` is therefore a position among elements
  *of that kind*, not in the whole list.

  Air on both sides is the whole definition, deliberately. A real mirror usually has a **substrate**
  behind it — glass the light never enters, there only to be drawn — and Zemax carries that in a
  surface's properties rather than in its prescription. That is where it belongs here too, and until
  it exists a mirror element is a surface and nothing behind it. Do not reach for the glass rule to
  express a substrate: the glass rule is about where light goes, and a substrate is about what a
  picture shows. (A `MIRROR` on a surface whose preceding medium *is* glass stays part of that run —
  a Mangin mirror, where the light really does pass through the glass twice.)

- **Every piece of glass has a color from the start**, cycled through `ELEMENT_PALETTE` by its
  position in the whole system so no two open alike. A design therefore arrives with its elements
  already told apart, which is the point of coloring them; the swatch always shows a real color rather
  than a placeholder standing in for one. A user's choice overrides the default and can be dropped
  again. **A crossed element keeps the fault color regardless**, in both views: the fill is the only
  thing saying the solid cannot be made.

  **A mirror's default color is the theme's own `--mirror`**, resolved through `useThemeColors()` and
  passed in, rather than a palette entry. Three things follow, and all three are the point:

  - A mirror is not glass and should no more wear a glass color than the ends do — and unlike the
    ends it is already drawn in a token that *moves between themes* (`#5f7180` light, `#9fb4c4`
    dark), so a fixed hex here would freeze it to one of them.
  - **Mirrors take no palette slot.** `colorIndex` counts gaps only, so dropping a fold mirror into a
    design does not repaint every lens behind it.
  - An untouched mirror is **absent from `surfaceColorsBySurface`**, so both views fall through to
    the token and resolve it themselves. Only a *chosen* color goes in the map. Getting this backwards
    would swap a color that follows the theme for one frozen to whichever theme was on when it was
    read.

  That map is the one both views take for anything drawn as a **single surface rather than a body**:
  the two ends, and any colored mirror. It stays separate from `elementColorsBySurface`, which is read
  by body — the 2-D view strokes a profile for every surface including the faces of a lens, so one
  combined map would quietly paint every lens face in its body's color. In the 3-D view it is read
  *before* the mirror and stop defaults, not after, or a mirror could never be given a color at all.

- **Element names and colors are view state**, in `App` beside the field checkboxes and the filename,
  keyed by the **id of the front surface** — of the element for a name, of the gap for a color — so
  they survive an insert above them. They are not on `OpticalSystem` because a `.zmx` has nowhere to
  put them: storing them there would either drop them silently on save or break the round trip. They
  are cleared on New, Reset and Open, since surface ids are only unique within one system and two
  files both call their first surface `surf-1`.

  The picker is a `<dialog>` rather than a popover anchored to the swatch, because the lens table
  scrolls in both directions and an anchored popover has to be re-positioned on every scroll. It
  offers **colors already in this design** first — defaults included, since those are what is on
  screen — then the palette, then the platform's own color input, which is the OS's full RGB picker.

- **A column's width comes from the `<colgroup>`, not from the `<th>`.** The lens table declares one
  `<col>` per column and sets widths there; a `width` on a `th` is only a suggestion the auto table
  algorithm may ignore, and this colgroup overrules it. **Adding a column means adding a `<col>`** —
  miss it and every column after the new one silently takes its neighbour's width, which looks like a
  CSS bug and is not one. The Element column is deliberately narrow (62px, name truncated with the
  full text on hover): every column pushed off the side is one a designer has to scroll for.

  **Those widths are what is asked for, not what is rendered.** `table-layout: fixed` hands out the
  declared widths only when they happen to total the width of the table; they sum to more than the
  `min-width`, so every column is already scaled down a little in a narrow pane, and they scale *up*
  once a pane is wider than the grid — a 70px Surface column renders at 86px in a 1660px panel. So
  anything needing a column's real width must measure it.

- **The header row and the Surface and Element columns are frozen.** A lens grid is read by row and
  by column at once — which surface is this, and which quantity — and both answers scroll off, so the
  two columns that *name* a row are pinned left and the header is pinned top, leaving the values to
  scroll between them. Four things this rests on, each of which breaks it alone:

  - **`.table-scroll` owns both axes.** `position: sticky` sticks within the nearest scrolling
    ancestor, so while the panel body did the vertical scrolling a header stuck to the top of a box
    growing with its own content never moved.
  - **The table is `border-collapse: separate`.** A collapsed border belongs to the table rather than
    the cell that declared it, so it stays put while a sticky cell slides away from it. Nothing here
    draws a border that meets another one, so zero spacing looks identical.
  - **Sticky goes on the cells**, never on `thead` or `tr` — sticky does not apply to row and
    row-group boxes in every engine.
  - **The second column's offset is measured**, published by `LensDataEditor` as `--frozen-offset`,
    for the scaling reason above. A constant would be right at exactly one panel width and leave a
    hole or an overlap at every other.

  Two consequences. A frozen cell must be opaque, so the row tint and the highlight mark are
  repainted onto it — and the Element cell, which `rowSpan`s a whole lens, belongs to only the first
  of its rows and so cannot be lit for the others; the Surface cell beside it is what says which row
  is live. And **the Element cell is absent from rows inside a span**, so these rules key off
  `.row-label` and `.element-cell` rather than `nth-child`, which would land on Surface Type.

- **Right-click belongs to the panel under the pointer, not to the browser.** Isaac is an
  application, not a document: the useful answer to a right-click on a lens row is what can be done
  to that surface, and Back / Reload / View source is noise in front of it. So
  `suppressNativeContextMenu` (`lib/context-menu.ts`) turns the platform menu off for a whole
  document, and each panel offers its own. It is called **twice** — once on `document` in `App`, and
  once on the second window's document in `SecondaryWindow` — because that window's background is a
  plain element made outside React: nothing that happens on it bubbles into the app's tree, so a
  handler on the app's own root would leave the platform menu live everywhere but the panels. A panel
  with no menu of its own does nothing on a right-click, which is the honest state of "not yet".

  The cost, said out loud rather than discovered: **a text cell loses the native cut/copy/paste
  menu.** The keyboard shortcuts are untouched, and an edit menu on the inputs is the obvious thing
  to add next.

  `ContextMenu.tsx` is the menu, and it needs nothing special to work in either window: `clientX`/
  `clientY` and `position: fixed` are both in the viewport of whatever window the event happened in,
  and everything it listens to comes from `element.ownerDocument`. Nothing in the app makes a
  containing block — no `transform`, no `filter`, no `contain` — so it also escapes the lens table's
  own scrolling box instead of being clipped inside it.

  Three decisions in it:

  - **A menu near an edge flips to the other side of the pointer**, rather than sliding back onto
    the screen. Sliding leaves the pointer in the middle of the menu, hovering an item nobody aimed
    at and one twitch from choosing it. `placeMenu` in `lib/context-menu.ts` is that arithmetic,
    unit-tested for the same reason `camera-fit.ts` is: every wrong placement still draws *a* menu.
    Sliding is the fallback for a menu with nowhere to flip to — taller than the window it is in.
  - **An unavailable item is ghosted, not hidden.** A menu whose items come and go teaches nobody
    what the panel can do, and the item that vanished is the one the user was reaching for. It
    carries `aria-disabled` rather than `disabled`, so the arrow keys still reach it and its tooltip
    can say which rule it ran into; clicking it does nothing *and leaves the menu open*.
  - **It closes on anything that moves what it points at** — Escape, a click outside, a scroll, a
    resize, the window losing focus. The menu is fixed to the viewport and the row it names is not,
    so a scroll would leave it offering to insert beside a different surface.
  - **A separator is carried by the item below it** (`startsGroup`), not written into the list as an
    entry of its own. A separator is not a thing to click — it exists only to say that what follows
    is different in kind — and spelling it this way makes the states that read as a bug
    unrepresentable: a rule at the top of the menu, one at the bottom, or two together.

  In the lens grid the items are **Insert surface above**, **Insert surface below**, then, past a
  rule, **Delete surface**. The inserts are in that order because the row is between them and the
  menu reads down the page in the direction it acts; below is what the `+` in the last column already
  does, and delete is the `×` beside it. Delete is set apart because it is the one item here that
  destroys something: the two inserts are undone by deleting what they made, this one only by Undo.
  Each is ghosted at the end it cannot reach — nothing goes above the object plane, nothing below the
  image plane, and neither end can be removed at all. The **same guards are in `edits.ts`**
  (`insertSurfaceBefore`, `insertSurfaceAfter` on the last surface, `removeSurface` on either end), so
  a caller that never saw this menu gets the same answer in its own words — the model would refuse it
  anyway, but by then the message is about an invariant rather than about what the user just asked
  for. The menu also **names the row in its heading**, because the pointer leaves the row on the way
  to the menu and takes the highlight with it.

  **Deleting a surface needs to tell the elements nothing**, which is the derivation earning its
  keep. An element is a run of glass between two faces, so removing a face is re-read on the next
  render as whatever run is left: drop a doublet's cemented interface and one gap remains, which is a
  singlet spanning two rows with one swatch; drop the face the glass *begins* at and there is no run
  at all, so no element — just a surface. `elements.test.ts` pins all three outcomes, because the
  whole point of deriving elements is that the answer is never stored anywhere to go stale.

  What *is* stored is `ElementStyles` — names and colors, keyed by surface id — and those are
  deliberately **not pruned when a surface goes**. An orphaned entry is harmless (`newSurfaceId` never
  reuses an id, and the styles are cleared on New, Open and Reset), while pruning would mean Undo
  brought the surface back without the color the user chose for it. Default colors are a different
  matter and do move: `colorIndex` counts gaps across the whole system, so deleting an element ahead
  of another one shifts the second's default color up the palette. Only a *chosen* color stays put,
  which is what choosing one is for.

- **The lens name is editable in the app bar**, because it is written into the file and has to be
  settable somewhere — and the app bar is where it was already shown, so the thing you see is the
  thing you edit. It reuses `TextCell` (draft on focus, commit on blur or Enter, Escape restores), so
  a rename lands on the undo stack once rather than once per keystroke. `renameSystem` **collapses
  whitespace**: the `NAME` record is whitespace-delimited and one line long, so `A  B` would come back
  `A B` and a newline would end the record and turn the rest of the name into stray tokens.
  Normalizing on the way in means what you type is what survives a save. An empty name is **refused**
  — every file carries the record, and a blank one reads back as "Untitled system", so the name would
  appear to survive the save and quietly not. The writer sanitizes the same way for `NAME` and `COMM`
  independently, since `exportZmx` can be handed any system and must not emit a broken file.

- **The app bar names two different things, and they are different on purpose.** `system.name` is
  the file's own `NAME` record — a *description* ("A SIMPLE DOUBLET USING A CROWN AND A FLINT.") —
  while the filename is where the design is stored. A file gets renamed without the lens being
  renamed, and usually is, so both are shown: the filename in mono and the lens name muted beside it.
  The filename is **view state in `App`, never on `OpticalSystem`**, for the same reason the field
  checkboxes are: where a lens lives is not a fact about the lens, and it must not land on the undo
  stack or be written into the file. Opening sets it, saving sets it to whatever the picker returns
  (which is how *Save As* renames), and New and Reset clear it — neither came from a file. The next
  save then suggests the name it already has, so saving twice never quietly proposes a second file.

- **Saving is a real file dialog where the browser has one.** `lib/save-file.ts` uses
  `showSaveFilePicker`, so the user names the file and picks the folder; where it is missing the only
  route is an `<a download>` click into the download folder with no say in either, so the result says
  *which* happened and the notice does too — "saved" and "sent to your downloads" are different
  enough that nobody should have to guess. **Cancelling is not failing**: the picker rejects with an
  `AbortError` when the dialog is closed, and reporting that would put a red notice in front of
  someone who simply changed their mind. The write itself is outside that catch, because a failure to
  write *is* a failure and swallowing it would report a save that did not happen.

- **The layout is two panels, not one panel with a switch.** `Layout 2D` and `Layout 3D` are separate
  entries in `PANELS`, so both can be on screen at once. They were one panel with a 2D/3D button, and
  splitting them survived the arrival of per-pane settings for a different reason than the one it was
  done for: the dropdown then says what you are about to get, and the panel id is what the Three.js
  chunk is gated on. `resetSignal` is now **local state in each panel component**, which is stronger
  than the counter-per-panel-type it replaced — two Layout 3D panels used to refit together, because
  the counter belonged to the type rather than to the copy.

  Both take wheel to zoom and a left drag to pan; the 3D view adds a middle-button drag to orbit, which
  is *not* Three's default mapping (it rotates with the left button) — the two views share a gesture
  vocabulary deliberately. The 2D view pans and zooms by rewriting the SVG `viewBox`.

  **The drawing scales; the ink does not.** Shrinking the `viewBox` magnifies *every* length in user
  units, the width of a stroke included — at 20x a 1.5-unit outline became a 30-pixel slab, the lens
  vanished inside its own edge, and the two strokes meeting at a rim showed a notch where their butt
  caps failed to overlap. `svg.layout *` therefore carries `vector-effect: non-scaling-stroke`, which
  moves the stroking into screen space: the geometry zooms, the pen does not. It is a blanket CSS rule
  rather than an attribute per shape because `vector-effect` does not inherit and a path added later
  must not be able to forget it. Dash patterns become screen lengths by the same property — a dashed
  axis stays dashed instead of stretching into bars — and a stroke no longer scales with the *panel*
  either, where a wide pane used to render every line nearly twice as heavy.

  Two things go with it. `stroke-linejoin: round` on the same rule, because a profile is a sampled
  polyline and a miter join on a tight curve throws a spike out of the corner; and `strokeLinecap`
  round on the profiles and the ground edges, so the two strokes ending at one rim point overlap into
  a corner at any weight.

  **A mark that is a legend holds its screen size**, and the ones that do it multiply by `zoom`
  (`view.width / WIDTH`): the gizmo, the first-order overlay's ticks and labels, the crosshairs that
  stand for the axis end-on, and the stop bars — which, left in drawing units, grew into the tallest
  thing in a zoomed picture. Anything measuring the *design* stays in drawing units, which is the
  whole of the distinction.

  **A pan cannot lose the drawing.** `clampPan` (`lib/pan-zoom.ts`) holds the view's *center* inside
  the fitted box, which is the simplest rule that keeps the picture on screen and behaves at both ends
  of the zoom: wound in, the view is small and reaches any part of the drawing but not past its edge,
  the way a map pans; wound out, the drawing can be pushed to the edge of the panel but never out of
  it. Unclamped, a drag simply kept going and the drawing left the panel with no hint of which way it
  had gone — recoverable only by Reset view, which is a poor thing to have to discover. Tested rather
  than looked at, because a view panned into empty space renders perfectly and shows nothing, which
  reads as a blank panel rather than as a bug.

  Marking the drawing area's border was the other idea, and it is **not worth drawing**: the box fills
  the panel body, so its top edge is the header's own rule and its sides are the panel's own border. A
  line there would trace what is already on screen. The only unmarked edge is the bottom one, where
  the drawing meets the legends.

  **`.layout-3d` is `flex: 1 1 0`, and the `0` is load-bearing.** It used to hold a fixed
  `aspect-ratio` so that toggling to 3D did not make the panel jump; with no toggle left, a fixed
  aspect in a panel that can be any height is just an overflow waiting to happen, so the canvas fills
  its panel instead. But `flex-basis: auto` bases the box on its *content*, and its content is a canvas
  R3F sizes *from* the box — a loop that settles on the canvas's untouched 300 × 150 default. Basis `0`
  takes the height purely from the flex free space and breaks it.
- **`Layout3DView` is lazy-loaded.** Three.js and React Three Fiber are ~900 kB of the bundle, and a session that never opens the 3D view should never fetch them. Keep it behind `lazy()`, and keep the volume trace gated on `panelsOnScreen(workspace).has('layout3d')` — the gate is what makes "never opened" mean "never traced and never fetched".

- **The 3-D camera is fitted against the canvas's own aspect**, in `lib/camera-fit.ts`
  — free of Three, and unit-tested, because it is arithmetic with a right answer that no
  screenshot can falsify: every wrong fit still draws *a* picture. `frameFor` measures
  the system, and `placeCamera` decides where the camera stands, which is why the fit
  happens **inside** the canvas: R3F renders this subtree while the canvas is still at
  its untouched 300 × 150 default and reports a size of zero, so `Controls` fits on the
  *measurement*, not on the mount.

  **Where the camera stands is a setting on the pane** (`Layout3DSettings.camera`), written on
  `OrbitControls`' `end` — once per gesture, never per frame. That is what carries an orbit
  through the remount described above, and it will carry one into a saved layout later. `start`
  marks the view as *framed by hand*, and almost everything follows from that one flag.

  Three effects, each one idea, and the deps are the whole design:

  - **Measurement** (`size`) — the first one to see a non-zero canvas puts the camera somewhere:
    back where it was left if there is a remembered view, and around the whole system otherwise.
    Later measurements refit only while nothing has been framed by hand.
  - **Subject** (`system`) — a different design is framed afresh, unless the user has framed it
    themselves; Reset view is one click and taking their viewpoint away is not.
  - **Reset view**, projection and fit margin — a deliberate hand-back, so these drop the
    remembered view as well as refitting.

  **`framing` is deliberately not a dependency of any of them.** It is measured from the *scene*,
  which includes the rays, so it is a fresh object every time the ray count or the field selection
  changes — and depending on it meant that turning the rays from 9 to 11 threw away an orbit. The
  subject of the picture had not changed, so the camera should not have moved. Near and far still
  come from the fit even when a remembered view is restored: a remembered position says where to
  stand, not what to be able to see, and a system that has grown since would be sliced by the old
  clipping planes.

  Two traps, both of which cost an afternoon:

  - **Never name a camera `position` in `<Canvas camera={{…}}>`.** R3F re-applies that
    object to the camera on every render, so anything named there is pinned and a fitted
    position is stomped on the next re-render. Field of view only.
  - **Field of view means nothing without the refit.** Turning it while the camera stays
    put is a zoom, not a change of perspective. `Controls` holds `distance · tan(fov/2)`
    constant instead — a dolly zoom, which keeps the system the same size on screen and
    changes only the depth of the picture. That is the knob that answers "too much
    perspective"; orthographic is its limit. The distance knob beside it slides the camera
    along the same ray and is the same question asked from the other end, so both are
    applied to wherever the camera currently is rather than by refitting — which is what
    lets an orbit survive being turned. Distance and `fitMargin` scale the one number;
    they are two knobs because a margin is how the fit frames and distance is where you
    then stand.

- **`src/dev/` is development only and is not in the production build.** `App` reaches
  `dev/TweakPanel.tsx` through a dynamic import behind `import.meta.env.DEV`, which Vite
  replaces with a literal `false` when building, so the branch and `lil-gui` with it are
  dropped — `lil-gui` is a devDependency, and the bundle is grepped to check rather than
  trusted. A library here where the rest of the app hand-rolls its controls, because
  everything that argues against one argues about *product* UI: this panel does not have
  to match Isaac's look, mirror across duplicate panels, or land on the undo stack.

  `dev/tweaks.ts` holds the knobs and their defaults; components read them through
  `useTweaks()`, which in a production build is `DEFAULT_TWEAKS` and a subscription that
  never fires. **The tweak is the experiment and the default is the result**: turn the
  knobs, press *Copy values*, paste the record into `DEFAULT_TWEAKS`. Values persist in
  `localStorage` so a session survives a reload. Nothing here may become a user-facing
  setting by accident — a knob worth keeping graduates to real UI, on `App` view state,
  rather than shipping as a frozen default behind a dev flag.
- **The page itself never scrolls.** `html`/`body`/`#root` are the window's height with
  `overflow: hidden`, the app bar is `flex: none`, and the workspace takes what is left. Anything too
  big for its panel scrolls *inside that panel* — `.panel-body` is `overflow: auto` on both axes. So
  the app bar and every panel header stay put, and no part of the design is somewhere the user has to
  go looking for it. `min-height: 0` on the panel, the column and the body is what actually permits
  the shrinking: a flex or grid item's automatic minimum is its content, so without it a tall table
  pushes the panel past the window and takes the whole promise with it. `100dvh`, not `100vh` —
  `vh` is the *largest* the viewport gets, so on a window with retracting chrome the bottom would sit
  under it with no way to scroll there.

  The left column's old `minmax(648px, 1fr)` is gone. It existed so the whole lens grid fitted at
  once; the table now scrolls inside its own panel, which is the trade that lets the window be any
  size. Panel headers **wrap rather than clip**, because a header is the one part of a panel that
  does not scroll, so in a narrow pane its controls would be unreachable.

- **The layout is a binary space partition, and that is the whole of it.** `lib/workspace.ts` holds a
  tree in which a node is either a **pane** — one panel on screen, or a blank one waiting to be told
  what to show — or a **split** of exactly two nodes, in a `row` (side by side) or a `column`
  (stacked). Every panel is a leaf, and the leaves tile the window exactly: nothing overlaps, nothing
  hides behind anything, and there are no gaps.

  It replaced a fixed two-level arrangement of columns holding slots, which could express only one
  shape — stacks side by side, with no way to add a column and no way to put two panels beside each
  other inside one. The tree has no such ceiling and is *less* code, not more.

  The one rule buys three properties, and each is a thing the old arrangement got wrong or could not do:

  - **Splitting is local.** `splitPane` replaces one pane with a split of that pane and a new blank
    one; nothing outside it moves, and the untouched half of the tree comes back as the very same
    object, so React re-renders only the branch that moved. The pane keeps its key *and its place in
    the flat list*, so it keeps its scroll position and, in the 3-D view, its camera.
  - **Closing gives the space to the sibling and to nothing else.** `closePane` replaces the split
    above the pane with its other child, which inherits what the pair held together. Exactly one
    panel on screen changes size. The old arrangement re-divided the whole column's weights, so
    closing one panel nudged every panel in that column at once and left the user hunting for what
    moved.

    Closing used to **rebuild the survivor**, which is why the workspace is now drawn flat — see
    the next point.
  - **A divider is a split's own `ratio`**, one number between 0 and 1. "The two together are exactly
    the parent" is therefore not an invariant anyone maintains — it is the only thing the type can
    say. A pair of weights could drift apart; a ratio cannot.

  **The root always exists.** Closing the last pane *blanks* it rather than removing it, so the
  workspace is never a dead end and there is no separate empty-workspace state to write — a blank pane
  already offers the panel list. Its close button is hidden, because closing it would do nothing and a
  control that does nothing is a puzzle.

  **A blank pane is the far half of every split**, never a copy of the panel just split. A split has
  to put something in its second child, and a blank is the honest something: a duplicate would be a
  guess, and half of them would be replaced immediately. Duplicating a panel is still one gesture —
  split, then pick the same panel — and it is chosen rather than assumed.

  **The tree says how the panes are arranged; `lib/tiling.ts` says where each one lands, and the
  workspace is drawn *flat*.** Every pane and every divider is an absolutely positioned child of
  `.workspace`, at a rectangle computed by walking the tree — no nested boxes mirroring it.

  The reason is React, not CSS. A component's state belongs to its **position in the React tree**,
  not to its key, and closing a pane moves its sibling *up a level*. Drawn as nested boxes, closing
  one panel therefore threw the one beside it away and built a new one: the lens table came back at
  the top of its scroll, the 2-D view refitted, the 3-D camera returned to its default. It looked
  like three unrelated bugs and was one. Drawn flat, a pane is a direct child of the workspace
  however the tree above it is rearranged, so a survivor is never rebuilt — and because splitting and
  closing preserve the *order* of the survivors, React never even has to move one, which matters
  because moving a DOM node loses its scroll position too and a moved canvas can lose its WebGL
  context. `tests/tiling.test.ts` pins that ordering along with the geometry.

  A position is an `Extent` — **a fraction plus a pixel correction**, rendered as a `calc()`. Neither
  half alone will do: the shares are proportions of a container whose size is unknown at that point,
  and the dividers are a fixed thickness that must not scale with the window. The margin around the
  workspace is in the rectangles too, because an absolutely positioned box resolves percentages
  against the padding box and would ignore a `padding` on `.workspace`.

  `components/Splitter.tsx` is the divider — a `role="separator"` with pointer capture (not a window
  listener: the drag leaves the element immediately, and capture also works in the second window,
  where a listener on the opener's `window` would not) and arrow-key support. It used to measure its
  **parent** to turn pixels into a fraction; drawn flat, every divider's parent is the whole
  workspace, so the split it belongs to is no longer something the DOM can be asked about and the
  tiling passes it down. What it is passed is the length the two children **share** — the split minus
  the divider itself — because that is what the ratio divides. Measuring against the whole split made
  the divider lag the pointer by about a percent, which the grid version did too and nobody noticed.

  The second window's root sizes and clips itself, exactly as the main workspace does — see below.

- **Any pane can be turned over to any panel**, chosen from the dropdown its header title *is*
  (`lib/panels.ts` names the panels, `lib/workspace.ts` arranges them, `Panel`'s `PanelChooser` offers
  them). The arrangement is data rather than the shape of the JSX — `App`'s `renderPanel` writes each
  panel once and `renderNode` walks the tree rendering it wherever its panes happen to be — which is
  the whole of what makes the dropdown possible. Blender is the reference for tiling without floating
  windows, but *not* for how you rearrange it: splitting by dragging a corner is a gesture you enter
  by accident and cannot discover on purpose, so every operation here is typed and named.

  **The split buttons are drawn, not lettered.** A rectangle with an upright rule for *split right*, a
  flat one for *split down*. "Horizontal split" means opposite things to different people — the cut,
  or the arrangement — and a picture cannot be read backwards. The code names the *arrangement* for
  the same reason (`row`/`column`), never the cut; `aria-orientation` on the divider names the bar,
  which runs across the direction it moves in and is the easy thing to get wrong.

  **The same panel may be open more than once, and what happens then depends on what it shows.** The
  rule is **input mirrors, output differs**, and it is the whole of `lib/panel-settings.ts`:

  - An **input** panel — Source object, Optical system — takes no settings and reads `system`
    directly, so every copy shows the same thing. Nothing keeps them synchronized because there is
    nothing to synchronize: add a field in one and the other shows it, because both are rendering one
    immutable model. There is one design, and two views of it disagreeing about it would be a lie.
  - An **output** panel — the layouts and the analyses — keeps its settings on **its own pane**, so
    two copies are independent. One Layout 2D on X–Z beside another on Y–Z is the point of opening a
    second, and a single app-wide "which plane" is exactly what used to prevent it.

  An earlier version of this file said copies were *indistinguishable*, and that anything two copies
  must differ in has to be a difference of panel. That was the rule until settings moved onto the
  pane, and it is now true only of the input panels.

  This is also why a panel is *replaced* rather than exchanged when the dropdown changes: with
  duplicates allowed there is no panel to rescue from being displaced. Its settings go with it —
  they describe the panel that has gone, and carrying them across is how a Layout 2D's plane ends up
  half-applied to a spot diagram.

  **A pane is not a panel, and the distinction is load-bearing.** A `PanelId` no longer identifies
  anything on screen once the same panel can be open twice — in one window or across both — so
  `Pane.key` does: React keys, and which copy was split or closed, all name the pane, while everything
  about *what is shown* names the panel. Keys need only be unique within one tree, since the two
  windows are separate React subtrees; both defaults therefore start their counters at 1 without
  colliding.

  **Closing is a red disc in the header, the Mac's own**, showing its × on hover. `nextKey` lives on
  the workspace so every operation is a pure function of it, which is what lets the tests check the
  operations rather than a side effect.

  One thing to keep straight: a divider parts two **subtrees**, not two panels, so `nodeName` labels
  it with a panel's name only when that side is a leaf and says how many panels are on that side
  otherwise. Naming it after one panel would be a lie the moment either side is split again.

  The chooser is a **native `select`** — keyboard-navigable and type-ahead searchable for free, drawn
  where the platform draws menus, which matters when a panel has been dragged too small to hang one of
  our own inside it. It stays inside the `h2`, so the document outline is what it always was and the
  heading's accessible name is the panel on screen.

- **The second window has a layout of its own.** The app bar's *Second window* opens a popup that
  starts with the lens grid over the 2-D layout (`DEFAULT_SECONDARY_WORKSPACE`) and is rearranged
  there exactly like the first: the same split, close and choose controls, its own tree, its own
  dividers. A second display is a second place to *lay panels out*, not a shelf to send them to.

  It replaced a per-panel ↗ button that detached one pane at a time and left a stub behind. Two trees
  is both less machinery and more capability — the stub, the detached map, the ordering list and
  `Placed.tsx` all went, and in exchange the second window can hold an arrangement rather than a
  stack. The default is chosen for what a second display is good for: the grid gets **every column at
  once** without scrolling sideways, and the layout below it is what a designer watches while editing.

  Still `createPortal` into the popup's document, *not* a second React root, and that is the whole
  reason it needs no synchronization: a panel out there stays in the one React tree, reads the same
  `system`, and is traced once. A second *tab* over a `BroadcastChannel` would have to be sent the
  design, and `OpticalSystem`/`Surface`/`Material` are class instances — `structuredClone` delivers
  their numbers without their prototypes, so the far side would be rebuilding the model and re-tracing
  it, and the two copies could disagree.

  Because there are now two trees, **every workspace operation has to name one**. `renderNode` takes
  the setter for the window it is drawing, and `choiceOf` passes it to each pane's controls — which is
  what keeps a pane in the second window from editing the first window's layout. The panel gate that
  the analyses hang off is the **union** of both, since a Layout 3D opened only on the second display
  still needs its pupil grid and still has to fetch Three.js.

  The second window's arrangement is kept while it is shut, so reopening brings back what was set up
  there rather than starting over. Both it and the handle are *view* settings in `App`, never on
  `OpticalSystem`.

- **Both arrangements outlive the session** (`lib/layout-storage.ts`). `localStorage`, not a cookie: a
  cookie rides along on every request and caps out near 4 KB, and this never needs to reach a server —
  the two default trees come to about 1.2 kB together. It works at all because a `Workspace` is plain
  data, so `JSON` is lossless on it; that is emphatically **not** true of `OpticalSystem`, whose class
  instances would come back as bare numbers with no prototypes, which is why the *design* is not
  stored this way.

  Read in a `useState` lazy initializer, **not an effect**: `localStorage` is synchronous, so the
  layout is in hand before the first paint, where an effect would render the default arrangement and
  then snap to the saved one. Written on a 400 ms debounce, because a divider drag calls `resizeSplit`
  on every pointer move and `setItem` is synchronous — a write per frame would stall the very gesture
  that has to stay smooth. Both the read and the write are wrapped: `localStorage` does not merely
  come back empty in a private window or with site data blocked, the accessor itself throws.

  **A library of named layouts, with each window pointed at one.** The version is in the **storage
  key**, so a future format is a different key: an old Isaac open in another tab keeps reading and
  writing its own, and neither corrupts the other.

  The strip above each workspace (`components/LayoutBar.tsx`) is where a layout is picked and managed:
  a native `select` of the names, and a `⋯` opening the same `ContextMenu` the lens grid uses — New,
  Duplicate, Rename, then, past a rule, Delete. Delete is set apart because it is the one thing here
  that destroys something, and the one with no way back: panels have an undo stack and an arrangement
  does not. The **last layout is kept whatever is asked**, for the same reason the root pane is
  blanked rather than removed — there is no dead end to reach.

  Three decisions in the operations themselves (`lib/layout-storage.ts`):

  - **The library is the one truth, and each window's arrangement is derived from it.** They were
    state of their own while a layout belonged to a window; the moment either window can be pointed at
    any layout there is nowhere for a second copy to live without going stale.
  - **Both windows may name the same layout, and then they mirror** — one tree drawn twice, so a split
    made in either is a split in both. That is the honest reading of "both windows are showing this
    layout"; quietly forking a private copy would leave two different arrangements wearing one name,
    which is the thing a named layout exists to prevent. The strip says so out loud while it is
    happening, because the alternative — a panel appearing in the other window unbidden — reads as a
    bug.
  - **New and Duplicate point the window at what they made**, so no key is ever handed back and
    threaded around: the rename box that opens after them acts on *whatever this window shows*, which
    is already the new layout. Generated names avoid the ones in use ("Layout 2", "Design copy"), but
    a name the user *types* is taken as typed — duplicates are allowed, since the key identifies a
    layout and silently numbering what someone just wrote would be worse than letting them see it.

  **Never trust the parse.** `JSON.parse` returns `any`, so a value written by an older Isaac
  type-checks perfectly and renders nothing — which looks like a bug in the app rather than in the
  storage. Everything is checked on the way in, and the rule is **repair rather than reject**: a pane
  naming a panel this build does not have is *blanked and keeps its place*, a ratio out of range is
  clamped, a setting of the wrong type takes its default. Losing an arrangement someone built over one
  bad value would be the worse failure. Two things are unrepairable and drop the layout: a tree that
  is not a tree, and **duplicate pane keys**, since React identifies a pane by its key and duplicates
  would silently merge two panes into one. `nextKey` is *recomputed* from the keys present rather than
  trusted, because a stored counter that is too low would mint exactly that duplicate.

  Settings are read by walking the **defaults**, so a value survives only if it is present and of the
  right type, and a setting added later gains its default automatically. A pane with nothing stored
  keeps `settings` absent rather than gaining an explicit copy of the defaults — which is the model's
  own word for "untouched", and what lets the round trip be checked for equality rather than for
  equivalence.

  Portals work across documents only because React attaches its event system to a portal's *container*
  and not merely to the root (`HostPortal` → `listenToAllSupportedEvents`); the popup's DOM events never
  reach the opener's root, so without that every control out there would be inert. Three consequences
  worth knowing:

  - **The window is opened by the click and closed by the caller**, never in an effect (`lib/secondary-window.ts`). A popup is only permitted while the user's activation is live, and an effect under StrictMode runs twice — which would open a window, close it, and open another; closing on unmount would leave the second pass portalling into a closed one. The window must also be closed when the *opener* unloads, or a dev reload leaves one stranded on the other monitor.
  - **The second document needs the CSS and the theme copied into it.** `<link>` elements are cloned once; `<style>` elements are re-copied whenever the opener's head changes, because that is how Vite serves CSS in development and a one-off copy goes stale on the first edit. `data-theme` is mirrored, which is what `theme.css` switches palettes on — the SVG views hand `var(--wave-blue)` to an attribute and it resolves in *that* document.
  - **Moving the window to the other display needs its own click.** Chrome's Window Management API is the only way a page can place a window, and `getScreenDetails()` raises its permission prompt only while the user's activation is live — which `window.open` has just consumed. So asking on the way to opening the window fails silently every time, having spent the very gesture the prompt needed. `screenPlacementState()` is queried up front; a *granted* permission needs no activation and rides along with the open, while an unasked one puts a **Move to other display** button in the app bar so the request gets a gesture of its own. Failures are reported, not swallowed: the first version caught everything on the grounds that the window was open and usable either way, and what that bought was a feature that did nothing and gave no reason.

  - **Anything reaching for `document` or `window` must take the one it is in.** Four places did: the lens table's keydown listener, the transform dialog's resize listener, and, in the 3-D view, both `devicePixelRatio` and — the subtle one — R3F's `ResizeObserver`. An observer belongs to the document of the realm that made it, so the one R3F takes from the global `window` never reports on an element in the second window, and the canvas sits at its untouched 300 × 150 default while its container is a thousand pixels wide. `resize.polyfill` hands `useMeasure` the right constructor; in the main window it is the very same one.

  `.secondary-root` sets its own height and hides its own overflow, exactly like the main workspace.
  That document is served the same stylesheet, so it inherits `body { overflow: hidden }` — right, but
  nothing else sizes its root, and a grid with nothing to fill would collapse to its content.

- **Colors for WebGL are resolved from `theme.css` at runtime** (`lib/theme-colors.ts`), and re-read when the theme changes — the SVG views hand `var(--wave-blue)` to an attribute and let CSS do it, but a material needs a real value. Don't start a second palette in TypeScript.

### `three-optics`

Three.js geometry for an `OpticalSystem` and nothing else: **no React, no renderer, no browser APIs** — it builds geometry in Node, which is how it is unit-tested. `apps/web` owns the R3F mount and the controls.

- Everything drawn is rotationally symmetric, so a surface is its meridional profile revolved. A glass element is *one* closed `LatheGeometry` running axis → rim along the front surface, across the ground edge, and rim → axis back along the rear; both ends on the axis is what closes the solid rather than leaving open caps.
- `LatheGeometry` revolves about **Y** and the optical axis is **Z**, so every geometry is rotated a quarter turn about X as it is built and comes out already in the engine's frame.
- Rays are the tracer's own 3D intersection points, merged into one buffer of line segments per (wavelength, blocked) group — hundreds of separate line objects would cost far more than the geometry does.
- Geometry is built outside React's reconciler, so `OpticalScene.dispose()` must be called when it is replaced.
- The crossed-element test is the same measurement `lib/layout.ts` makes, so the two views agree about which elements are impossible.

### Conventions that span files

- **The model keeps the lens file's vocabulary; the UI may relabel.** `Surface` calls a coordinate transform's five numbers `decenterX`, `decenterY` and `tiltXDeg`/`tiltYDeg`/`tiltZDeg`, which are Zemax's words and the `.zmx`'s. The editor shows them as *Translate* and *Rotate*, which is what they do. Keep the split: **Isaac is meant to write `.zmx` eventually as well as read it**, and a round trip is far easier to keep honest when the data model already speaks the format's language — a rename at the field level would have to be undone on the way out. The same reasoning is why `COORDBRK` stays `COORDBRK` in `zemax-io` even though the model type is `COORDINATE_TRANSFORM`: translation belongs at one boundary, not scattered.
- **Coordinates:** right-handed; optical axis is +Z; sequential rays propagate −Z → +Z. Geometry math happens in each surface's *local frame* (vertex at origin); `trace.ts` converts to/from global coordinates using `OpticalSystem.vertexZAt(i)`.
- **Axial layout:** surface vertex positions are *derived*, not stored per-surface. `OpticalSystem` places surface index 1 (first surface after OBJECT) at z = 0 and accumulates `thickness` forward; the OBJECT surface sits behind at negative z (or −∞ for an object at infinity). A surface's `thickness` is the distance to the *next* surface, and its `material` is the medium *after* it (toward +Z).
- **System invariants:** a system needs ≥ 2 surfaces; first must be `OBJECT`, last must be `IMAGE`. At most one surface may be the stop (`isStop`, `STANDARD` or `PARAXIAL` only), reachable as `OpticalSystem.stopIndex`. Constructors validate aggressively and throw `RangeError`/`TypeError`.
- **Surface geometry:** stored as `radius` (`Infinity` = plane; positive radius ⇒ center of curvature toward +Z); `curvature` is the derived `1/radius`. `semiDiameter` is how far out the surface is **drawn**, and stops nothing; `aperture` is what vignettes, and `Surface.blocksAt(x, y)` is the single definition of where.
- **Surface power** is `surfacePower(surface, nBefore, nAfter)` (in `tracing/paraxial.ts`), the single definition of the `φ` in `n'u' = nu − yφ`. Every recurrence goes through it — `paraxialTrace`, both pupil solves, the reversed front-focal-distance trace, and `trace.ts`'s ideal bend — so a new surface type gains power in one place. Power is unchanged by reversing the system, so the backwards traces pass their media in *forward* order rather than flipping a curvature sign.
- **Immutability:** `Ray`, `Surface`, and `OpticalSystem` are all immutable and expose `.with(changes)` (plus `OpticalSystem.withSurfaceAt`) to derive copies. Solves and editor edits return new systems; axial geometry is recomputed in the constructor.
- **Paraxial:** `paraxialTrace` runs the y–u recurrence (`n'u' = nu − yφ`, `y += u't`) starting *at surface 1*, skipping the IMAGE surface. `EFL = −y₁/u'` and `BFD = −y_k/u'`. Mirrors throw — the axial layout assumes forward propagation — and so does a system with no refracting surface.
- **Pupils:** `entrancePupil`/`exitPupil` image the stop through the surfaces before/after it by tracing two rays from the stop (center → location, rim → size). The entrance-pupil solve runs *backwards*, in a reversed frame ζ = −(z − z₁) where curvatures flip sign and the media swap. A pupil may be virtual (behind the stop, or in front of surface 1); a zero exit slope means telecentric and throws.
- **Ray generation:** normalized pupil coordinates `(px, py)` span the entrance pupil (unit circle = rim). Rays are aimed at the solved entrance-pupil plane when the system has a stop, and at surface 1's vertex plane otherwise. All four aperture types work: `ENTRANCE_PUPIL_DIAMETER`, `OBJECT_SPACE_NA`, `IMAGE_SPACE_FNUM` (from the paraxial EFL, infinite conjugate only), and `FLOAT_BY_STOP` (from the stop's semi-diameter). Objects at infinity take `angleDeg` fields and launch from a plane in front of surface 1; finite objects take `objectHeight` fields and launch from the object plane.
- **A ray may step backwards, but only where the prescription does.** `MISSED` means the ray never meets the surface, not that it meets it behind itself: a **negative thickness puts the next surface behind the one before it**, which is how a *remote stop* is written — the aperture stop of a telecentric system sits far downstream and the file steps back to where the glass is. `stepsBackward` in `trace.ts` measures the axial step **against the direction of travel**, so it reads the same in a reflecting arm, where thicknesses and travel are both negative and their product is ordinary forward propagation. A backward hit where the prescription steps forward is still `MISSED`, and that half matters too: an image plane buried inside the last lens is nominally ahead, and reporting a hit there hands `quickFocus` a fake perfect score — one axial ray, scoring zero.
- **Aiming is paraxial (first order).** A ray aimed at the pupil rim can miss the stop edge by the residual aberration and come back `BLOCKED` — see the test that pins this. Closing that gap needs iterative *real* ray aiming, which is deliberately not implemented.
- **Ray outcomes:** `traceRay` walks surfaces in order and returns a `RayTraceResult` whose `intersections[]` carry everything a future visualizer needs (points, normals, in/out directions, indices, AoI). Terminal `RayStatus` values: `TERMINATED` (reached IMAGE), `BLOCKED` (aperture), `MISSED` (no intersection), `TIR` (total internal reflection).

## Scope discipline

The goal is to replicate **most of what OpticStudio does** (see `Architecture.md`). Nothing is
"out of scope" on principle — mirrors, coordinate transforms, conics/aspheres, optimization, MTF, and
PSF are all wanted, and non-sequential tracing is wanted eventually. What follows is the *current
state*, not a fence.

Implemented today: plane, spherical, conic and even-aspheric surfaces, Snell refraction, mirrors
(traced, paraxially analyzed, and drawn), **coordinate transforms**, **surface apertures and
obscurations — circular, rectangular and elliptical**, sequential tracing, and first-order/paraxial
analysis. Surface types are
`OBJECT`/`STANDARD`/`EVEN_ASPHERE`/`PARAXIAL`/`COORDINATE_TRANSFORM`/`IMAGE`, with reflection a flag on
a surface rather than a type of its own.

The discipline is **completeness, not restraint**: a capability lands modeled, traced, *paraxially
analyzed*, tested, and shown in the UI — not stubbed. A half-built feature that silently returns
wrong numbers is worse than an absent one, because the UI will plot it without complaint. So keep
refusing what cannot yet be modeled, with a clear message, rather than approximating it.

That standard is why mirrors landed the way they did: the gap between a tracer that reflected and a
`paraxial.ts` that refused to was closed in one go, along with the reader, the editor and both
views, rather than shipping a mirror the first-order summary could not describe.

**Clear aperture and drawn extent are two facts, and they are now two fields.** This was the standing
gap: `semiDiameter` did both jobs, so Isaac blocked any ray past it while Zemax blocks none — its
semi-diameter column is for drawing and manufacturing, and only an explicit aperture record
vignettes. The cost was visible on OpticStudio's Hubble, where 10 of 11 fan rays came back `BLOCKED`
at a dummy baffle and the layout looked broken while the first-order numbers were exactly right.

Closing it took one idea: **a surface stops light only where it says it does**. `semiDiameter` is now
the drawn extent alone, `Surface.aperture` is what vignettes, and `Surface.blocksAt` is the single
definition of the boundary — the tracer asks it, and so does anything drawing a hole, so a picture
cannot show an aperture the trace does not have. That is also why 141 of the 471 sample files carry
`FLAP`: a floating aperture is how a file asks for the semi-diameter to *be* the limit, and without
one nothing is asked for. Hubble's fan is now 1 of 11 blocked — the center ray, stopped by the
secondary's shadow.

Seven kinds are modeled (`model/aperture.ts`), in two families. The **circular** family is bounded by
two radii — `CIRCULAR` (`CLAP`, light between them), `CIRCULAR_OBSCURATION` (`OBSC`, light stopped
between them) and `FLOATING` (`FLAP`) — and the **sized** family by a half-width in x and one in y:
`RECTANGULAR`/`RECTANGULAR_OBSCURATION` (`SQAP`/`SQOB`) and `ELLIPTICAL`/`ELLIPTICAL_OBSCURATION`
(`ELAP`/`ELOB`). `isCircularAperture` is which family a kind is in and `isObscuration` is which way
round it reads; every consumer branches on those two rather than on the kind itself.

**A number from the other family is refused, not ignored** — the same rule that stops a `PARAXIAL`
surface carrying a radius. The one wrinkle: `normalizeAperture` is handed its own output every time a
`Surface` is copied, and a normalized circular aperture carries half-widths of *zero*, so the check is
for a non-zero value rather than a present one. Refusing zeros would make an aperture impossible to
edit, which is the kind of bug that only shows up three screens away from its cause. The decenter lives **on the aperture**, which is the file
format's own arrangement (one `OBDC` serving whichever aperture the surface has) and the right one:
an off-axis hole is not an off-axis surface — that is a coordinate transform, and it moves the glass
too.

**A decentered aperture is how an off-axis element is written**, and it is worth understanding
before touching any of this. Zemax's `Unobscured Gregorian` is the canonical case: a coordinate break
puts the parent conic's vertex 100 mm off the beam, and the mirror then carries `CLAP 0 55` with
`OBDC 0 -100`, which takes a 55 mm circle back on the beam. The aperture is not a hole in a mirror
there — **it is which piece of the parent surface the mirror is**. Ansys's own tutorial says so in
one line: "The decentered aperture on this surface aligns the mirror with the incoming beam."

Two consequences, and both are why the file sets that surface's semi-diameter to **zero**:

- **The aperture is the drawn extent when there is one.** `drawnDisc` in `lib/layout.ts` takes the
  radius *and the center* from the aperture, falling back to the semi-diameter and then to the view's
  default. Drawing the semi-diameter instead would draw the parent disc — a mirror nobody has,
  straddling the axis the design exists to keep clear. An obscuration is the exception and falls
  through, since it is something in the way of a surface rather than the bound of one.
- **A stop can have no size of its own.** That file's stop is a bare plane whose pupil is declared by
  `ENPD`, so `entrancePupilPlaneZ` finds the pupil *plane* without asking how big the stop is — only
  the ray from the stop's center is needed for that, and it starts on the axis whatever the size.
  `entrancePupil` still refuses to invent a radius. When the stop does have a size, `stopRadius`
  takes it from the **aperture** first and the semi-diameter second: a stop whose `CLAP` says 25 mm is
  a 25 mm stop however large the surface is drawn.

**A surface the lathe cannot express is drawn as a patch instead** (`three-optics/src/aperture-patch.ts`).
A lathe is a surface of revolution, and three of the shapes the model allows are not one: a
rectangular aperture, an elliptical one, and a circular one cut off the surface's own axis.
Revolving those anyway drew the right size in the wrong shape or the wrong place — a rectangular
mirror as a disc, an off-axis parabola straddling the axis — which is the quiet kind of wrong, since
it still renders a solid and still looks like an optic.

The patch is polar **about the aperture's center**, which is what lets one function cover all of
them: at each angle the aperture reaches some boundary radius, and the material runs from its hole
out to that boundary. A circle's boundary is constant, a rectangle's is the nearer of its two walls,
an ellipse's is the ellipse. The **sag is still measured from the surface's own axis**, never from
the aperture's center — an off-axis parabola is a piece of the parent and curves the way the parent
does at that distance out.

`needsAperturePatch` is the test, and a centered circle — annulus included — stays a lathe, which
draws it better and with fewer triangles. A glass *body* whose faces need a patch is not welded into
one solid, for the same reason a transform between the faces prevents it: the ground edge would have
to join two boundaries of different shapes, which is a solid this cannot build yet.

The live gap now is **the aperture shapes that are not a size at all**: `SPID`, the spider, whose
radial arms hold a secondary, and `UDAD`, a polygon read from a separate file. Both are a different
*shape* rather than a different size, so each belongs as its own kind rather than as a case of one of
these; until they land they stay in `UNMODELED_SURFACE_TOKENS`, warned about per surface.
