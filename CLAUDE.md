# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Isaac is a web-based optical design system inspired by Zemax/OpticStudio. It is an npm-workspaces monorepo. Five packages live under `packages/`, and two applications under `apps/`: `@isaac/optical-core` (`packages/optical-core`), the portable optical calculation engine; `@isaac/zemax-io` (`packages/zemax-io`), the reader and writer for `.zmx` lens files; `@isaac/glass-catalog` (`packages/glass-catalog`), the manufacturers' glass data; `@isaac/three-optics` (`packages/three-optics`), Three.js geometry for the 3D layout; `@isaac/session-protocol` (`packages/session-protocol`), the wire format for a collaborative session; `apps/web`, the React UI; and `apps/session-server`, the relay that carries a session between browsers.

**`Architecture.md` is the charter and this file is the map.** That document says why Isaac exists, states the one hard rule, and orders the priorities; when a question is about *purpose* — is this worth doing, does it belong here, what standard does it have to meet — that is where the answer is. Everything about how the code actually works, and every convention that spans files, is here, and here is where it stays current. Where the two disagree about a detail, this file is right and the other one is out of date.

## Commands

Requires Node >= 22.6. The **engine packages have no build step** — TypeScript runs directly via Node's `--experimental-strip-types`, and `.ts` files import each other with explicit `.ts` extensions (`allowImportingTsExtensions`). Only `apps/web` is bundled, by Vite, because a browser cannot execute `.ts`.

Stripping *removes* types and emits nothing, so **any syntax that would need code generated is out** of everything outside `apps/web` — no `enum`, no `namespace`, and no constructor parameter properties (`constructor(private readonly x: number)`, which has to become a field and an assignment). `tsc --noEmit` is happy with all three, so this surfaces only when the file is run.

TypeScript is pinned at the root (`typescript@^7`). Before that pin the repo silently used whatever `tsc` was on the machine; TS 7 also needs `"types": ["node"]` in each engine package's tsconfig, without which `@types/node` is not picked up and every `node:*` import fails to resolve.

- `npm test` — run all workspace tests (root).
- `npm run typecheck` — `tsc --noEmit` across workspaces; the only type-safety gate, since nothing is compiled.
- Run one test file: `node --experimental-strip-types --test packages/optical-core/tests/trace.test.ts`
- Run one package: `npm test --workspace @isaac/zemax-io`
- Run the UI: `npm run dev` from the root (Vite, http://localhost:5173) — `npm run dev --workspace @isaac/web -- --host`. The `--host` binds every interface rather than loopback, so the app is reachable from a phone or tablet on the same network at the LAN URL Vite prints. That also means **anyone on the network can reach the dev server**, which serves out of the project directory — fine at home, not on a shared or public network. Note that a LAN address is not a *secure context* the way `localhost` is, so `showSaveFilePicker` and the Window Management API are absent there: Save falls back to a plain download, which is exactly the fallback path in `lib/save-file.ts`, and the second window is unavailable. `npm run build --workspace @isaac/web` is the only bundling in the repo.
- Tests use the built-in `node:test` runner + `node:assert` — no test framework is installed.
- Cross-package imports (`@isaac/optical-core` from `zemax-io`) work through the workspace symlink; run `npm install` at the root after adding a package so the link exists.
- **Checking Isaac against OpticStudio**: `npm run compare -- <lens.zmx> <prescription.txt>`
  reads a System/Prescription Data export and compares every surface, aspheric
  coefficient, first-order figure and cardinal point against the same design read
  by Isaac. Exits non-zero on a disagreement, so it can gate a change. `--all`
  lists every check, `--json` emits them. See "Checking against a prescription".
- **Deploying** (see `infra/`): `npm run deploy:relay` ships `apps/session-server` to
  the Linode; `npm run deploy:web` builds `apps/web` and ships it to
  `isaacoptics.com`; `npm run deploy` does both, relay first — if the protocol
  changed, the server should understand the new client before the new client
  arrives. Both scripts verify themselves against the public URL afterwards, so
  a deploy that reports success has been checked from outside. `npm run
  server:logs` and `server:follow` read the relay's journal, and `npm run
  help:usage` (optionally `-- -7d`) totals what the help assistant has cost from
  the same journal — the Console's billing figure is current but its analytics
  panels lag it by about a day, so this reads the per-request accounting the API
  itself returned rather than waiting for a rollup.

  Secrets and knobs come from the gitignored `infra/.env.deploy`, which
  `deploy.sh` pipes into `/etc/isaac-session.env` — never echoed, and never
  passed as an argument, which would be visible in `ps` to everyone on the box.
  `ANTHROPIC_API_KEY` turns the help assistant on; `ISAAC_HELP_MODEL` and
  `ISAAC_HELP_DAILY_LIMIT` set what an answer costs and how many are allowed in
  a day.

## Architecture

The hard rule (see `Architecture.md`): **`optical-core` must stay independent of React, Next.js, Three.js, browser APIs, and UI.** It must remain runnable from browser JS, Web Workers, WebAssembly, and Node. Concretely, do not use Three.js `Vector3` (or any DOM/framework type) inside the core — it has its own `Vector3`/`Point3` primitives, and the core should stay portable enough to reimplement in WASM. UI/visualization layers talk to the engine only through the `OpticalSystem` data model and `traceRay`.

The core is layered, and imports flow one direction: `geometry` → `model` → `tracing`. `src/index.ts` is the single public barrel; prefer adding to it over deep imports from consumers.

- **geometry/** — pure math: immutable `Vector3`, `Point3`, `surface-sag.ts` (the sag `z(r) = cr²/(1 + √(1 − (1+k)c²r²)) + Σ αᵢr^2i`, plus its slope and vertex curvature) and `intersectSurface` (ray/surface intersection in a surface's *local frame*, vertex at origin, axis +Z). `surface-sag.ts` is the **single definition of surface shape** in the repo — the tracer intersects it, `paraxial.ts` takes its vertex curvature from it, and both layout views draw its profile, so a surface cannot be drawn as one shape and traced as another. `intersectSphericalSurface(o, d, c)` remains as the sphere/plane shorthand.
- **model/** — the data model: `Ray` (immutable; `.with(changes)` returns a copy and re-normalizes direction), `Surface` (which exposes its `shape`, built once in the constructor because the tracer reads it per ray per surface), `aperture.ts` (what stops light at a surface, and the one function that answers it), `Material` (`ConstantMaterial`, `SellmeierMaterial`, `ModelGlassMaterial`, plus `AIR`/`N_BK7`/`MATERIAL_CATALOG`), and `OpticalSystem`.

**`ModelGlassMaterial`** is a glass described the way a patent describes one — `nd` and the Abbe number, optionally `ΔPg,F` — rather than by measured Sellmeier coefficients. It is a two-term expansion in Buchdahl's chromatic coordinate `ω = (λ − λd)/(1 + 2.5(λ − λd))`, with `ν₁`/`ν₂` fixed by `nF − nC = (nd − 1)/Vd` and `nG − nF = Pg,F(nF − nC)`. **It is not OpticStudio's model glass**, whose formula is proprietary and unpublished; do not try to reproduce that one. Accuracy is pinned by `glass-catalog`'s `model-glass-accuracy.test.ts`, which rebuilds all 365 g-line-covered SCHOTT glasses from three numbers each and holds the median drift under 5e-5 and the worst under 5e-4 across 400–700 nm. `normalLinePartialDispersion` is the K7–F2 line (`0.6438 − 0.001682·Vd`); recomputing it from those two glasses' real fits gives `0.6442 − 0.001688·Vd`, which is where the constants are verified.
**`PARAXIAL` surfaces** are ideal thin lenses: a plane that bends rays by the paraxial law and nothing else, used as a placeholder for a lens group not yet designed. Power comes from `focalLength` (φ = 1/f), which is *required* on a `PARAXIAL` surface and rejected on every other type; a radius is refused rather than ignored, since it would be a second, contradictory source of the same power. The real trace applies `n'u' = nu − yφ` to the ray's two transverse **slopes** (`dx/dz`, `dy/dz`), not to its direction cosines — that is what makes the surface *ideal*: a collimated bundle lands at exactly `f·u` however wide the aperture, so the surface contributes first-order power and no aberration. Because f is read as `1/φ`, a paraxial surface between unequal media focuses at `n'·f`; the two readings coincide in air, which is how these surfaces are actually used, and `zemax-io` refuses an immersed one rather than pick a convention.

**Tilted surfaces.** A `TILTED` surface is Zemax's `TILTSURF`: a *plane at an angle*, whose whole
shape is the two tangents in `tiltTangents` — `z = x·tx + y·ty`, taken from `PARM 1` and `PARM 2`.
A radius or a conic is refused on one, the same way a `PARAXIAL` surface refuses a radius: the
tangents are already the shape, and a second statement of it would contradict them.

**It is the first shape in the model that is not a figure of revolution**, and that is what it costs.
Everything else here is a function of `r` alone — which is what lets a profile be revolved, a quadric
be solved in one variable, and a sag be asked for at a *height*. So a tilt is allowed only on a plane,
where the geometry stays exact: `intersectSurface` answers it in closed form before the quadric solve
is reached, and the normal is the same everywhere. Drawing asks `surfaceSagAt(shape, x, y)` rather
than `surfaceProfileSag(shape, r)` — a profile sampled at a height alone cannot see a tilt and would
draw a wedge flat — and `needsAperturePatch` is true for one, since a lathe cannot revolve it either.

**Not a substitute for a coordinate break**, and the manual says so outright: a tilted surface bends
light at a tilted plane while leaving the axis where it was, which is a prism face or a tilted
detector. A fold mirror *moves the axis*, and that is a transform.

**A tilted object or image plane is refused for now**, with the reason named: those two are surface
*types* here rather than positions in the list, so a surface cannot be both `OBJECT` and `TILTED`.
Two sample files need it (`Tilted object.zmx`, `Example 6, tilted image plane.ZMX`), and it is what
the `OBJECT`/`IMAGE`-as-a-position refactor is for.

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

The format has **no *current* public specification** (dropped from the Zemax help system ~2005), but a pre-2005 one survives: **Chapter 29 of the 2000 Zemax manual** in `SupportingMaterial/` (gitignored) is a full keyword table, and Chapter 14 gives the per-surface-type `PARM` column meanings. Its argument *orders* match all 471 OpticStudio sample files **with one known exception — `SPID`, where the columns are reversed** (see below); it predates later additions, so it is also stale on argument *counts* (`WAVM`, the extended `FTYP`/`UNIT`). Check it before inferring a token's meaning — and note that several tokens lead with a placeholder, so `firstValue()` is only correct for single-argument records (`RAIM`'s first value is a dead `tol` field, not the aiming mode). Beyond what it covers, the rule stands: interpret only what has been verified against real files, report everything else in `ignoredTokens`, and *refuse* rather than approximate when geometry cannot be modeled (surface types outside `STANDARD`/`PARAXIAL`/`EVENASPH`, `MODE NONSEQ`, unresolved glass unless `allowUnknownGlass`). Glass resolution is injected via `resolveMaterial` — `zemax-io` must not grow its own glass database; that is `glass-catalog`'s job.

**`ignoredTokens` is not a defect list.** A real file carries 30-plus record types that are annotation, not prescription — notes, tolerancing, display flags, multi-configuration, non-sequential and physical-optics settings — so a long list is normal and says nothing about whether the import is right. What matters is separated out into `warnings`: `UNMODELED_SURFACE_TOKENS` (`SCBD`, `UDAD`/`USAP`, `PKUP`, `XDAT`/`YDAT`) are the ignored *surface* records that would move a ray, so their presence is warned about per surface; and `warnHeaderSettings` reports vignetting factors (`VDXN`/`VDYN`/`VCXN`/`VCYN`/`VANN`) that are not all zero, ray aiming (`RAIM` ≠ 0, which this reader cannot do — see "Aiming is paraxial"), and an `ENVD` environment away from 20 °C / 1 atm. Each is warned about only when it departs from the no-op value nearly every file carries. Don't add a token to those lists on a guess about its meaning; leave it in `ignoredTokens`. The UI must present the two differently — warnings up front, ignored tokens folded away.

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

**Checking against a prescription.** `parsePrescription` (`src/prescription.ts`) reads
OpticStudio's **System/Prescription Data** report, and `comparePrescription`
(`src/prescription-compare.ts`) checks an `OpticalSystem` against one. Neither is used
by `apps/web`; they exist because **Isaac's own tests can only check Isaac against
Isaac's understanding**, so a convention held wrongly by the code and its tests
together is invisible to all of them at once. That is not hypothetical — it is
exactly how the effective focal length was wrong on immersed systems for a year with
535 passing tests. A second program's arithmetic is the only thing that finds it.

Three things this had to learn, each of which makes everything look broken if missed:

- **A masked value is a range, not a number.** Under a licence that does not permit
  full disclosure the report replaces trailing digits with `X` — `974.011X`,
  `-3.585XXXe-15` — so a comparison can only ask whether Isaac's number falls
  *inside*. Parsing up to the `X`s invents precision the report withheld. Two limits
  set the interval, and both are read off the report rather than assumed: the mask
  begins at a fixed decimal place (three, in all 1743 masked values of the one export
  measured, whatever their magnitude — so `inferMaskedDecimals` counts it), and the
  rendering carries about seven significant figures, which cuts in first on a large
  value. `-109987.5` is a radius of `-109987.496020` printed to seven figures and so
  to *one* decimal, unmasked; reading its slack as three decimals calls the true value
  a disagreement. Conversely a suppressed trailing zero is not a missing digit —
  `1188.66` is `1188.660` with the zero dropped, and giving it a half-unit range would
  pin nothing. `PrescriptionCheck.pinned` therefore travels with every check, because
  **an agreement is only as strong as the digits it was checked against** while a
  disagreement is a disagreement either way.
- **Image-space positions are measured from the image surface, with the index divided
  out**; object-space positions from surface 1, and **not** divided. The cardinal points block
  states both in prose and the comparison *reads those sentences back* rather than
  trusting a comment — a report that words them differently is warned about instead of
  quietly checked against the wrong frame. It is not only the cardinal points: the
  general block's Back Focal Length and **Exit Pupil Position** are in the same frame
  and never say so. The index is taken by magnitude, for the reason `signedMediaIndices`
  exists. The two columns are **not** symmetric, which took an immersed *object*
  space to show: image space is referred to air, object space is left in the
  medium's own units and its focal length carries the index. And the general
  block's Effective Focal Length is referred to **object** space, so an odd number
  of mirrors does not turn it over — it reads `+340.548` where the same report's
  cardinal block reads `-340.548` and Isaac agrees with the cardinal one. That
  fits all three exports known: no mirrors (7301707), one (Dyson1959), and two
  (the Unobscured Gregorian, negative in both). Read a disagreement there as a
  convention to check rather than a wrong focal length.
- **Total track is the axial extent, not last vertex minus first.** A mirror sends
  the later surfaces back the way they came, so the last one is behind the first
  and the difference is negative. **`MIRROR` in the Glass column is not a medium**
  either: it is a flag on the surface, and reading it as a material name compares
  it against whatever the mirror sits in.
- **A stop is not always what limits the beam, and OpticStudio names the beam.** Its
  *Stop Radius* and *Exit Pupil Diameter* are the beam at those places; Isaac's
  `stopRadius` is the stop's own clear radius and `exitPupil().radius` images the whole
  stop. The two coincide only on a system that floats its aperture by the stop, which
  is why it went unnoticed until a design declaring `ENPD 1000` with a stop drawn 29.93
  across made all three figures differ by the same 6.45%. The beam radius at the stop
  is `entrancePupilRadius / |entrancePupil().magnification|`, and it is derived in the
  comparison rather than added to the engine.

The section boundaries matter as much as the parsing: a surface row's shape also
matches `EDGE THICKNESS DATA` and everything after it, which is how a first attempt
read 393 surfaces from a 65-surface lens. `OBJ`, `STO` and `IMA` are **positions, not
names** — `'STO'.replace('STO','')` is `''` and `Number('')` is 0, so a stop read by
stripping its label lands on the object plane.

Verified against one real export (a 65-surface immersion lithography objective): 462
checks agree, none disagree. `tests/fixtures/prescription.txt` is a fixture for the
*format* and carries one deliberately wrong coefficient, so the test proves a
disagreement is caught rather than only that agreement is reported; the tests that pin
a *convention* build their report by hand from an immersed singlet whose answers are
derived on paper, because every lens in the corpus sits in air, where all three focal
lengths coincide and both conventions are invisible.

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
- `DISPERSION_FORMULA.CONRADY` (5) — `n = n₀ + A/λ + B/λ^3.5`, 5 of MISC's 23. The odd one out: every other fit here is a series in λ² and so even in λ, while this is three parameters in λ itself with a fractional power. It is what a catalog carries when a material was characterized from three measured lines and nothing more — three coefficients for three measurements — which is why it turns up on obsolete glasses and on materials measured once in the literature. **The 3.5 is Conrady's own exponent, not an approximation of 4**; read as 4 the fit still returns plausible indices, so there is a test asserting the two are not interchangeable.

Any other formula number is **refused**, not approximated. The gaps (3 Herzberger, 4 Sellmeier 2, 5 Conrady, …) are real numbers left unimplemented because no glass in the catalog uses them; adding one is a case in `dispersionMaterial`. Reading a fit under the wrong formula still returns plausible indices, so the formula number must travel with the coefficients — there is a test on exactly that.

**`MISC` is materials rather than products**, 23 of them: fused silica and quartz, calcium fluoride, Pyrex, water and seawater, the plastics (PMMA, polycarbonate, polystyrene, CR-39), a few crystals, and `VACUUM`. Things a lens is made of, or sits in, that no maker sells under a catalog name — so each entry cites its own literature source (mostly the Handbook of Optics) instead of a manufacturer's datasheet, and the file ships with OpticStudio rather than being published by whoever makes the material. Its `CATALOGS` row is therefore `optional: true`: a *manufacturer's* catalog missing means an incomplete checkout and should fail loudly, while this one may simply not have been collected.

Two things it exposed that the makers' own catalogs never could:

- **A zero coefficient is a term, not padding.** An `.AGF` writes ten coefficient slots whatever the fit needs, so the reader trims the tail — but MISC's `CDS` is a *two-term* Sellmeier written as six numbers whose last two are zeros that mean zero, and trimming those left four coefficients and a formula that wanted six. `DISPERSION_COEFFICIENT_COUNT` is published from `optical-core` so a reader can tell the two apart; every SCHOTT and Ohara glass fills all six slots, which is why this sat undiscovered.
- **A catalog that printed nothing cannot be checked against.** An `NM` record carries nd and Vd whether or not anyone filled them in, and an unfilled one reads as exactly `1.000000` — an index no solid has, and the format's way of saying the field is empty. `CDS` and `CR39` print 1.0 for both; `N15` is deliberately non-dispersive, so its Vd is written 0 where the fit gives infinity, which is the same statement twice. Those three skip the gate and are counted in the output; **every entry that states a value is still held to it**, which is the whole of what the gate is for.

- `SCHOTT` and `OHARA` are the ready-made per-maker catalogs, and **`ALL_GLASSES` is the one a lens file wants** — a `.zmx` names a glass, not the catalog it came from, so `apps/web` resolves against all makers at once. Combining them throws if two catalogs share a name once normalized, which is the right failure: the file would be ambiguous and picking a winner silently traces someone else's glass. **MISC produced the first real collision**, and it is a genuine ambiguity rather than a duplicate — `LAF3` is an obsolete SCHOTT lanthanum flint (nd 1.717, Vd 48.0) and, in MISC, the crystal lanthanum fluoride (nd 1.604, Vd 80.8). Two materials, one name, and nothing in a `.zmx` to tell them apart, since a file names its libraries in `GCAT` and this reader does not use it yet. So `ALL_GLASSES` is built **in order** — the makers, then the materials — and the manufacturer wins, on the grounds that a prescription naming `LAF3` far likelier means the glass someone melted. The shadowed entry is not lost (`MISC.get('LAF3')` still returns it) and is named in `SHADOWED_GLASS_NAMES`, with a test asserting that list is exactly `['LAF3']`: a second collision arriving should stop somebody and make them look. `GlassCatalog.get(name)` normalizes case and separators (`N-BK7` = `n bk7` = `NBK7`), and construction throws if two names collide once normalized. Nothing else about a name is guessed at.
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

  **A surface whose only job is to obscure has no outline**, in either view: a plane in the air, not a
  mirror and not a face of any glass, carrying an aperture that stops light rather than bounding the
  surface. Its semi-diameter is a number the program computed, so drawing its rim invents a pane —
  and on the Newtonian, whose dummy diagonal plane is drawn at 78 where the optics reach 50, that
  invented rim also set the scale for everything else. The outline is not merely hidden but *not
  sampled*, since the points are what the drawing's bounds are measured from.

  **An obscuration is drawn as the thing it is.** It does not bound the surface — the surface keeps its
  own extent — so it is stroked *over* the outline, at three times a ray's width and in `#000000`,
  across the runs it covers. **`--obscuration` is the one token here that does not change with the
  theme**: black is what "light does not get through" looks like, on the dark panel and the light one
  alike, and it is the same black the 3-D mesh and the table's icon use. Square ends, because a round
  cap adds half a width beyond each end — on a short run that is most of the mark, and a baffle read
  as a fat lozenge zoomed out and straightened into a bar zoomed in, while its width never changed at
  all. **Runs, plural, and asked rather than derived**: an obscuration need not
  cross a section in one piece — a decentered spider does not — and rather than re-derive each kind's
  geometry a second time, `SurfaceProfile.obscured` is the list found by asking `Surface.blocksAt` at
  every sample, the same function the tracer calls. That is what makes the promise hold in the hard direction as
  well: the picture cannot show an obscuration the trace does not have, nor miss one it does.
  Without that, an obscuration smaller than its surface is drawn nowhere at all: **seven of the
  twenty-two in the sample corpus are**, including both Newtonians' diagonals and the Flat-field
  Schmidt's, and the trace stopped those rays while the picture showed nothing stopping them. That is
  the same fault as drawing an aperture the trace does not have, read backwards.

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

- **Six rules the aperture icon settled, which every schematic here now follows.**
  They came out of one long pass over that icon and are written down so the next
  component does not rediscover them.

  **Floor, ceiling, and a real proportion in between.** Draw the true proportion
  where it can be seen, and clamp at both ends where reality runs off what a glyph
  that size can show — then say which case it is. Applied three times over: a
  vane's width, a hole's radius, a ring's thickness. Real designs reach both ends,
  and two proved it: a spatial-filter pinhole is five microns in ten millimetres,
  one part in two thousand, and LSST's thinnest baffle is a ring four parts in a
  thousand thick. State a limit as the thing that has to stay visible — a *ring
  thickness*, not a fraction of the disc — so it survives the glyph being resized.

  **Say when the drawing stops telling the truth.** A clamped decenter is a lie
  about position, so the icon marks the edge the aperture left through. Without
  it, Zemax's off-axis Gregorian — 55 mm cut 100 mm off axis — simply looked badly
  drawn rather than far away.

  **One geometry, many presentations.** `ApertureArtwork` is shared by the table
  icon and the dialog preview while their sizes are not, and `ApertureIcon` and
  `AperturePreview` are separate components on purpose. Size and surroundings are
  presentation and may diverge; *where a decentered obscuration sits* may not. It
  is the same rule as `Surface.blocksAt` being the single definition of a
  boundary, and the same failure if broken.

  **A picture that follows the edit beats a paragraph.** The dialog led with prose
  explaining what an aperture is; it now leads with the aperture, drawn large,
  changing as the numbers below it are typed. No sentence can do that.

  **Name the viewpoint.** A 2-D picture of a 3-D thing must say which side it is
  seen from or two views will quietly disagree. The icon draws the surface as the
  3-D home camera sees it — **+x left, +y up** — which is the *opposite hand* from
  the X–Y layout, and that is deliberate and documented rather than an accident.
  A bare sign flip is never the fix: there is no viewpoint with +x right, +y up in
  which a right-handed roll looks clockwise, so flipping a rotation without its
  decenter draws the tilt from one side and the position from the other.

  **A failure must not look like a success.** The recent-files store swallowed
  every error, so a missing object store, a refused write, a rejected clone and
  "nothing opened yet" all produced one screen: names with no handles and no
  reason. It took a console session to tell apart what should have been four
  different messages. This is the same discipline as *refuse rather than
  approximate* on the reader's side, and it applies to any silent fallback — a
  broken file picker and a working one must not produce the same result.


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
  are absent and the list is a history — said in the UI rather than hidden. **The app bar shares that
  list**; see "Opening is a recent-files menu".

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

  **But a medium with an index is not automatically glass, and a fluid is not an element.**
  `isSolid` in `optical-core` is the test, and all three consumers take it — the lens table, the
  2-D section's body fill, and the 3-D lathe — so none of them can draw a solid the others do not.
  The distinction is not about index and could not be: seawater is 1.340 and Cargille Type A
  immersion oil is 1.515, squarely inside the range of real glasses. It is about **whether the
  medium has a figure of its own**. A lens is a thing you can pick up and its faces are surfaces
  somebody ground; a fluid takes the shape of whatever holds it, so its "faces" belong to the glass
  and the detector either side of it. Air and vacuum are the same statement at index 1, which is why
  they never needed saying.

  `FLUID_MEDIA` is the closed list — WATER, SEAWATER, TYPEA, VACUUM — and every entry is a record in
  the `MISC` catalog, where the materials that are nobody's *product* live. `optical-core` cannot
  depend on `glass-catalog`, so it carries a copy of their nd and Vd; `glass-catalog`'s
  `fluids.test.ts` pins that copy against MISC, the same arrangement that keeps the core's N-BK7
  honest.

  **A fluid is recognized by its numbers as well as by its name**, and it has to be: a design taken
  from a paper names no glasses at all. `Liang2002a.zmx`, a schematic eye, writes the vitreous
  humour as a model glass at 1.33304403094 / 55.7943215 — MISC's water to every digit that catalog
  prints — and read as glass it makes the crystalline lens and the vitreous one cemented doublet
  ending on the retina. The numeric route applies **only to a model glass**, one that is nothing but
  an index and an Abbe number; a glass with a real dispersion fit behind it is a melt somebody sells
  and is taken at its name. The tolerance is 1e-3 in nd and 0.5 in Vd, and the nearest solid in every
  catalog Isaac carries is 0.0175 and 0.62 away — a test asserts that margin rather than assuming it,
  so a future catalog entry that closed it would stop somebody and make them look.

  **The rule is about the material, not about the row**, and the corpus is why. Eight fluid gaps
  across five files, and they sit in all three places: before the image plane (the immersion
  lithography objective `7301707.zmx`, whose last surface is `GLAS WATER` and whose image plane is
  the wafer), *between* two lenses (`Yu2024.zmx`, `7301707-spherical.zmx`), and behind the object
  (`sc_endo1.zmx`, an endoscope looking into water). A positional rule — "whatever touches the image
  plane is not part of a lens" — would miss two of those three cases and break four files that are
  right today: `Dyson1959.zmx` images *inside* a solid block of fused silica, and a detector with a
  window cemented to it is written the same way. An element's span reaching the image row is
  legitimate; a fluid in it is not.

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

- **An element can be switched out of the light.** The yellow ring in the Element cell takes it out of
  the *traced* system while leaving every row where it is — a "what does this element do?" control,
  which only works if the before and after are comparable. So nothing moves: the surfaces keep their
  positions and every thickness downstream is untouched, and a hidden lens simply becomes **air**,
  which a surface with the same medium on both sides is indifferent to whatever its radius. A hidden
  *mirror* stops reflecting and the light carries on, which usually leaves the rest of a folded
  design somewhere the beam no longer goes — the honest answer to "what if this mirror were not
  there", said out loud rather than prevented.

  `App` therefore holds **two systems**: `system`, the design, which the lens grid and the source
  panel read; and `tracedSystem` (`systemAsTraced`), which everything that draws or traces reads. A
  hidden element is absent from the pictures, the fans *and* the first-order numbers alike — switch
  the doublet out and the focal length reads `Inf`, which is the truth about a system with no power.
  Derived on every render, so switching back on restores exactly what was there and nothing lands on
  the undo stack.
  **A switched-out element is gone from the pictures too**, not merely made of air. Air on both sides
  already makes a surface do nothing to a ray, so the trace would be right either way — but a lens
  still drawn where the rays run straight through it says the drawing and the trace disagree, and the
  drawing is what the user is reading. `hiddenSurfaceIndices` is the set, and both views take it:
  `buildLayout` skips those profiles and any body they bound, `buildOpticalScene` builds no geometry
  for them. It is indices rather than ids because that is what both views already key on, and it is
  computed from the same `ElementStyle.hidden` flag the trace reads, so a surface cannot be hidden in
  one and present in the other. **The two ends are never in it** — the object and image planes are
  positions, not glass, and the image plane is where the spots land.

  **And the rows are ghosted and read-only.** A row that still takes an edit while contributing
  nothing is a trap: the number changes, the plots do not, and there is nothing on screen saying why.
  So `.row-switched-out` dims the row and every cell in it is `disabled` — except the Element cell,
  and the structural Insert buttons, which act on the *system* rather than on the surface's values.
  `disabled` rather than `readonly`, since a disabled control is out of the tab order too, and a row
  nobody can edit is not a row anybody should have to tab through.

  **The dimming is on the cells' contents, and the Element cell is exempt outright.** Two things
  forced it there. A `td` at 0.45 alpha is a `td` you can see through, and the two frozen columns are
  frozen precisely because their backgrounds are opaque — so the values would scroll visibly under the
  Surface number. And the switch is what puts the element *back* in the light, so dimming it hides the
  one control the row still needs; a dim control does not look like one you can press. Everything in
  the Element cell is live, and full brightness is the only thing that says so, which makes the rule
  legible rather than arbitrary: bright is live, dim is inert. `.row-label` holds bare text rather
  than a control, so it is dimmed with `color` instead.

- **The Element cell is a stack with the switch laid over its left edge.** The name sits above the
  swatches and both are centered in the column; the switch is `position: absolute`, so it takes no
  width from them and the column does not jog between an element's row (which has one) and an end's
  (which does not). It is centered on the *content* rather than on the cell, since a cell spanning a
  doublet's three rows is far taller than what it holds — which puts it exactly between the name and
  the colors. Its outer diameter is a swatch's own side, because the two are read together down the
  column and a smaller circle beside a square reads as a different kind of thing.

  **The name is text, not a field.** Renaming is an operation on the element and belongs with the rest
  of them in the cell's own menu; an input here spent the width the switch needed on a border around a
  name that is two characters long. The ends already showed text there, so the column now uses one
  type for both.

  **Hover brightens the ring, never the fill.** The global `button:hover` fills a button with
  `--surface-2`, which on this control read as the *on* state arriving early: the center darkened
  under the pointer and cleared when it left, so the switch appeared to answer the mouse rather than
  the click.

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

- **Opening is a recent-files menu, and Open is the first item in it.** The app bar held a bare
  `<input type="file">` — 190px spent on the words "No file chosen", and no way back to a file
  already opened, which meant hunting through the corpus for a lens that had been on screen an hour
  earlier. It is now one button putting up the same `ContextMenu` the lens grid uses: **Open .zmx…**,
  a rule, then the ten most recent. Open stays *inside* it because a menu reads down the page and
  Open Recent under Open is where every editor puts it — and because removing Open outright would
  leave a fresh install, whose list is empty, unable to open anything at all.

  **One list serves the app bar and the Text panel**, since "what have I had open?" is one question
  and a file read in one is very often the file wanted in the other. Each end filters it: the app bar
  loads a *design*, so `lensFileRecents` keeps `.zmx` only — offering a `.txt` there would promise a
  lens that is not there and fail after the click. That is why the stored list (30) is longer than
  any menu (`MENU_LIMIT`, 10): a run of text files must not be able to push every lens file out of
  the app bar's ten.

  **An entry with no handle is ghosted, with the reason on hover.** A recent is only a shortcut if a
  `FileSystemFileHandle` was kept for it; without one it is a *name*, and clicking it can only produce
  an error. `keysWithHandles()` reads them all in one transaction whenever the list changes — before
  the menu is drawn, not when it opens, since resolving it on open would ghost half the entries a
  moment after they appeared. The recent is recorded **only once the import has succeeded**: a file
  that could not be read is not one to offer reopening, and putting it at the top of the list would
  make the next session's first click a repeat of the same error.

  **The picker is a plain function, not a `useCallback`.** Memoizing it with `[]` captured the first
  render's `loadFile` and with it an empty `recents`, so every file opened through
  `showOpenFilePicker` reset the list to itself. The fallback `<input type="file">` never showed it,
  because its handler is written inline and is fresh every render — which is exactly the shape of bug
  that survives a test driving only the fallback path.

- **The layout is two panels, not one panel with a switch.** `Layout 2D` and `Layout 3D` are separate
  entries in `PANELS`, so both can be on screen at once. They were one panel with a 2D/3D button, and
  splitting them survived the arrival of per-pane settings for a different reason than the one it was
  done for: the dropdown then says what you are about to get, and the panel id is what the Three.js
  chunk is gated on. `resetSignal` is now **local state in each panel component**, which is stronger
  than the counter-per-panel-type it replaced — two Layout 3D panels used to refit together, because
  the counter belonged to the type rather than to the copy.

  Both take wheel to zoom and a left drag to pan; the 3-D view adds a middle-button drag to orbit,
  which is *not* Three's default mapping (it rotates with the left button) — the two views share a
  gesture vocabulary deliberately. The 2-D view pans and zooms by rewriting the SVG `viewBox`.

  **The 3-D orbit point moves when you pan, and a cross is drawn where it is.** `OrbitControls` pans
  by translating the camera *and its target* together — in its model panning **is** moving the target
  — and `zoomToCursor` drags it too, so the point everything turns about walks further from the optics
  with every gesture. Where it starts is already poor: the scene's bounding centre, which on the
  sample doublet is z = 52.7 with the glass at z = 0–9 and the image at 106.4, so 53 units of empty
  space from anything there is to look at.

  **Holding it still was built and then reverted, and the reason is worth keeping.** Panning the
  *frustum* instead of the camera — `camera.setViewOffset`, a window onto a larger virtual image —
  leaves position, quaternion and target untouched, so the orbit point genuinely cannot move. It
  works, and it is arguably the truer picture: a view camera's rising front, where what occludes what
  does not change. But it is a uniform 1:1 translation of the projection, while a pan driven by a
  *pointer* is expected to keep the thing you grabbed under the cursor — which at any other depth it
  does not. It stopped feeling like a pan. Restoring the target after an ordinary pan is not an option
  either: the target is also where the camera *looks*, so putting it back undoes the pan.

  So the mark is the answer for now, and letting the user **choose an element to orbit about** is the
  real one. It is rescaled every frame to hold one size on screen, since the target is nowhere near
  the camera and a fixed world size would be a speck from one angle and fill the frame from another,
  and drawn over everything because the point is inside the glass as often as not.

  There is no `camera.lookAt` anywhere in the app. `OrbitControls.update()` calls it every frame with
  `controls.target`, so **the target is the only thing that decides where the camera looks** — set in
  one place, when a view is applied.

  **A replaced design gets a fresh view; an edited one does not.** `App` counts `designSignal` on the
  three things that replace a lens outright — opening a file, New, Reset — and never on an edit, and
  the 3-D panel adds it to its own Reset-view signal, since a new design is the same deliberate
  hand-back the button is. Without it a camera the user had framed survived into the next file
  together with **clipping planes measured for the previous system**, so a lens could load correctly
  and simply not be on screen. `[subject]` cannot answer this on its own: every edit makes a new
  `OpticalSystem` too, and refitting on each would take the viewpoint away while someone was working.

  There is no `camera.lookAt` anywhere in the app. `OrbitControls.update()` calls it every frame with
  `controls.target`, so **the target is the only thing that decides where the camera looks** — set in
  one place, when a view is applied.

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

  **The drawing is memoized apart from the view that frames it** (`LayoutContent`), because a pan
  changes `viewBox.x`/`.y` and *nothing else in the picture*: the geometry is in drawing units, and
  the marks that hold a screen size scale with `zoom`, which panning does not touch. Only the gizmo
  genuinely needs the pan, being pinned to the corner of the visible area. Without the split, every
  pan frame reconciled the entire subtree to arrive at the identical picture — measured at **13.7 ms
  per move against 4.25 ms after**, on 126 nodes; a real design runs to seven hundred, and 31 rays
  across 3 fields dragged at about 22 fps.

  Two things make it work, and each is worthless without the other. `project` and `origin` are
  memoized — both were rebuilt every render, and one fresh object fails the shallow compare and costs
  the memo *everything*. And it is a **component with props rather than a `useMemo` with a dependency
  list**: a value read inside and forgotten in a deps array would go stale only while panning, which
  is the kind of wrong nobody finds for months, whereas a missing prop does not compile.

  Verify this structurally, not by eye. Chrome throttles `requestAnimationFrame` *and* clamps
  `setTimeout` to one second in a background tab, so frame timing from an automated session is
  meaningless; and 30 pointer moves dispatched synchronously are batched by React into one render,
  which reads as a memo working when it is not. Yield on a `MessageChannel` between moves — what
  React's own scheduler runs on, and the one macrotask Chrome does not throttle.

  **A mark that is a legend holds its screen size**, and the ones that do it multiply by `zoom`
  (`view.width / WIDTH`): the gizmo, the first-order overlay's ticks and labels, the crosshairs that
  stand for the axis end-on, and the stop bars — which, left in drawing units, grew into the tallest
  thing in a zoomed picture. Anything measuring the *design* stays in drawing units, which is the
  whole of the distinction.

  **A pan cannot lose the drawing, and the room it leaves does not change with the zoom.**
  `clampPan` (`lib/pan-zoom.ts`) requires that **whichever of the view and the fitted box is smaller,
  its center lies inside the other**. Wound in, the view is smaller, so its center stays on the
  drawing and every part can be reached, the way a map pans. Wound out, the drawing is smaller, so
  its center stays inside the view and it can be put anywhere in the panel. Unclamped, a drag simply
  keeps going and the drawing leaves the panel with no hint of which way it went — recoverable only
  by Reset view, which is a poor thing to have to discover.

  **The first version was only the first half of that rule**, applied at every zoom: the view's center
  was held inside the fitted box whether or not the view was the smaller thing. That is a limit stated
  in drawing units, so the room it left *on screen* shrank in step with the drawing — the center could
  travel `fitted.width` units at any zoom, which is the whole panel when fitted and an eighth of it
  wound out eight times. The panel got bigger while the room to move got smaller, which is the
  complaint that found it: "a big panel but the object can only occupy a tiny portion of it — makes no
  sense." Under the symmetric rule the travel is **exactly one panel's width at every zoom**, verified
  in the app as well as in the unit test: 1092px of travel on a 1092px panel with the plot drawn at
  1092px, at 636, at 259 and at 136.

  There is a lesson in how long that survived. It was tested — four tests, all passing, none of which
  asked the question a *user* asks, which is not "does the clamp hold" but "how much can I move
  this?" A rule can be correct on its own terms and still be the wrong rule, and no amount of testing
  the terms will say so. The test that pins it now measures screen travel as a fraction of the panel.

  **The plot window is drawn, as a hairline** (`.plot-extent`): the box from (0, 0) to
  `WIDTH × boxHeight`, which is the area the drawing is composed in and what Reset view frames. At the
  fitted zoom it lies along the panel's own edges and says nothing. Wound out it is the only thing
  that does — the drawing becomes a speck in a large dark panel, and this is what separates the part
  of that emptiness which is the plot from the part which is merely outside it.

  Do not confuse it with a frame around the *design's own bounds*, which is a different rectangle and
  was built first by mistake. That one tracks the object; this one is the room the object sits in, and
  the room is what a reader is missing when everything has receded into the dark.

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

  **The frame meter** (`dev/StatsMeter.tsx`, `stats.js`) is under *Performance* in the same
  panel. Two readouts, because they answer different questions: **FPS** is capped at the
  display's refresh rate, so it says "smooth or not" and stops being informative the moment it
  reads 60, while **MS** is the frame interval and keeps moving either side of that line — it
  is what shows a change costing 30% while the frame rate still reads 60, and what a
  measurement in a commit message should quote.

  **It is off by default and costs nothing while off.** An FPS meter can only work by running
  a `requestAnimationFrame` loop, and that loop keeps the page painting continuously whether
  or not anything changed — precisely the sort of thing that gets blamed later for the lag it
  was opened to measure. Switching it on starts the loop; switching it off cancels it and
  removes the canvases. Verified both ways: zero rAF calls while off, and zero for two seconds
  after switching off.

  Its toggle is **not** a field of `Tweaks`, deliberately. Every key in that record is a value
  being settled on, and `formatTweaks` writes all of them out to be pasted into
  `DEFAULT_TWEAKS`; a display toggle emitted into that source would ship as a frozen default,
  which is the one thing the tweak store is not for. It has its own storage key instead.

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

### The help assistant

A **Help** panel (`components/HelpPanel.tsx`) that answers questions about Isaac, and about
the design currently open. The model runs on Anthropic's servers; what runs in the browser is
a chat box.

**The whole shape follows from one fact: an API key in a browser bundle is a key anybody can
read.** So the key lives on the relay machine and never leaves it — `apps/session-server/src/help.ts`
holds it, and `lib/help.ts` in the app knows a URL. That is also why the endpoint is *on* the
relay: it is the server Isaac already has, already behind TLS, already deployed by a script that
verifies itself.

**It is the deliberate opposite of the relay beside it.** The relay routes and does not
understand — every payload it carries is `unknown`, which is what keeps it from growing opinions
about optics. This endpoint exists precisely to understand, so it is a separate file with its own
configuration and it never touches a room. Neighbors, not the same thing.

Four decisions worth keeping:

- **`src/manual.md` is the only thing the assistant knows about Isaac**, and it is written for
  the person *using* Isaac. This file — the one you are reading — is written for whoever is
  building it, and serving it would answer "why does my doublet look wrong" with a paragraph
  about `elementColorsBySurface`. They are two documents with two audiences and they stay apart.
  The manual is read **once at startup**, not per request: prompt caching is a prefix match, so
  re-reading a file a deploy might have changed would silently turn every question back into a
  full-price one.
- **A refusal is a good answer, and the prompt says so.** A model asked about a program it cannot
  see will invent a menu item, and an invented menu item is worse than no answer, because
  somebody goes looking for it. This is the failure this project already has a name for —
  *verify, don't guess* — arriving in user-facing form, so the manual ends with an explicit list
  of what Isaac does not have and the instruction to treat the manual as complete.
- **The design travels with the question** (`describeSystem` in `lib/help.ts`), and that is what
  makes this worth building rather than a link to a docs page. Isaac holds the whole system as
  plain data, so "why are my rays blocked?" can be answered about *this* lens. The summary is
  built from `system` and not `tracedSystem` — a switched-out element is absent from the traced
  one, and answering "there is no such surface" about a row plainly on screen would be worse than
  useless. It is laid out like the lens grid, column for column, so an answer can be checked
  against what is on screen; a button in the panel shows the user exactly what is being sent.
- **The caps are the feature, not the paperwork.** A spending endpoint anyone can reach is one
  somebody eventually will. There is a per-caller window, a hard daily total, a bounded body, a
  bounded question and a bounded answer — and the tests are *all* refusals, because the refusals
  are the half that runs before any money is spent. `ISAAC_HELP_MODEL` and
  `ISAAC_HELP_DAILY_LIMIT` change the cost of an answer without a deploy; no `ANTHROPIC_API_KEY`
  means the endpoint answers 503 and says why, which is the right default for a development
  machine and for anyone else's checkout.

Two smaller things. The token is spelled **two ways** and that is forced rather than sloppy: the
socket carries it in the query string because the WebSocket API cannot set headers, while `/help`
takes `x-isaac-token`, because an ordinary request can set one and a token in a URL lands in
nginx's access log. And the conversation is **component state, not a pane setting** — a setting is
something worth reopening with, and two Help panels should plainly hold different conversations
rather than mirror one.

`infra/smoke-help.mjs` asks a real question after every deploy. It costs a fraction of a penny and
it is the only way to learn that a key was rotated, a model name went stale, or an origin rule now
refuses the app — all three of which fail *only* on a real call.

**The assistant can act, not only answer**, and the actions are ordered by what it costs to be
wrong. They are declared as *tools* but used as **structured output**: the model emits at most one,
the browser performs it, and nothing is sent back for the model to read. That is one API call rather
than three. A genuine tool loop is what you need when the model must see a result before answering,
and none of these are that.

| Action | Does | Undone by |
|---|---|---|
| `highlight_surface` | Flashes a row, or rings one **cell** and scrolls it into view | looking away |
| `open_panel` | Splits the Help pane and puts a panel in the new half | closing it |
| `load_design` | Replaces the design with one it wrote | Undo |
| `propose_edits` | **Nothing** — draws a before-and-after and waits | not applying it |

Five things hold this together:

- **Every action is something the app can already do.** `setHighlightedSurface`, `setPanePanel`,
  `importZmx`, `edits.ts` — nothing here is a capability that exists only for the assistant, which
  is the property worth keeping: a route only it can take is a route only it is tested on.
- **A written design goes in through the file reader.** Same validation, same refusals, same
  warnings a real `.zmx` produces — so an impossible prescription is refused rather than traced.
- **But reading correctly is not being the right lens, and that is the real failure here.** The
  first Cooke triplet written by the assistant parsed perfectly, carried the right glasses in the
  right order, and came out at **f/55 because every curvature was an order of magnitude too weak**.
  It imported, it traced, it drew, and nothing said a word. So `load_design` *requires* the model to
  state the focal length and F/# it is aiming for, `App` traces what actually arrived, and a
  disagreement past 20% is reported in the notice. That is the same discipline as `glass-catalog`
  refusing to write a fit it cannot reproduce — and being made to state an intent visibly improved
  the prescriptions, which was not the reason for doing it.
- **`propose_edits` never acts.** `lib/help-actions.ts` has two halves and the order is the point:
  `previewEdits` builds the before-and-after that is shown, and nothing calls `applyEdits` until a
  button is pressed. Application is **all-or-nothing** — a half-applied proposal leaves the design in
  a state nobody described, with one undo entry that puts back only part of it — and each step goes
  through `edits.ts`, so a refusal comes back in the engine's own words. A row that cannot be made is
  *shown with its reason* rather than dropped, because a list with a line silently missing cannot be
  checked against what the assistant said it would do.
- **The assistant names *what*, and the app decides how it looks.** Pointing at a cell takes a
  column from a closed list (`HIGHLIGHT_COLUMNS`, matching `data-column` on the cells), never a
  style. Handing over CSS was the obvious-looking alternative and is worse in three ways: an answer
  could hide a row or break the layout with no undo; a literal color would be frozen to one theme,
  which is the mistake `theme-colors.ts` exists to prevent; and the vocabulary would be tied to
  whatever the stylesheet happens to be, so a class rename would silently stop the pointing working.
  Naming a value is a stable fact about the table; naming a color is not. Most of the value is the
  **scroll into view** — the grid scrolls sideways, and Material and Semi-diameter are off the right
  edge in a narrow pane, so lighting a row the reader cannot see does nothing.
- **`pointedCell` is deliberately not `highlightedSurface`.** That one is driven by hovering and by
  the layout views; sharing it would let a mouse crossing the grid wipe out an answer's own pointing
  gesture. Two gestures, two pieces of state: one says "the pointer is here", the other says "the
  thing you asked about is *there*".
- **A model calling a tool usually writes no prose at all** — the call *is* the answer, as far as it
  is concerned — and a blank space above a proposal reads as a fault. So the tools needing an
  explanation carry one as a *required field* (`note`, `why`) rather than relying on a prompt
  instruction to produce one, and `proseOf` falls back to it.

Streaming is server-sent events, opted into with `stream: true` on the request. The total time is
unchanged; what changes is that four seconds of a blank box reads as broken and four seconds of
prose appearing reads as thinking. Two things it needs: `x-accel-buffering: no`, without which nginx
holds the whole answer to the end — the exact pause streaming exists to remove, and it would look
like a browser bug rather than a proxy one — and a **failure delivered as an event**, since by then
the status line is long gone and a stream that simply stops is indistinguishable from one that
finished.

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
- **Paraxial:** `paraxialTrace` runs the y–u recurrence (`n'u' = nu − yφ`, `y += u't`) starting *at surface 1*, skipping the IMAGE surface. A system with no refracting surface throws; mirrors do not, and have not since `signedMediaIndices` arrived.

  **There are three focal lengths and only one of them is the EFL.** `−y₁/u'` with the real exit slope is `n'/φ`, the *image-space* focal length — a true distance, from the rear principal plane to the rear focus, measured in whatever the image sits in. `n/φ` is its object-space twin. `effectiveFocalLength` is **`1/φ`**, the same length referred to air, which is what OpticStudio's EFFL prints, what divides the entrance pupil to give the F/#, and what anyone means by "the focal length". The index is divided out by **magnitude**, so the mirror sign survives: image space really does run backwards after an odd reflection, and `|n'| = 1` leaves Hubble and the Gregorian untouched.

  **The object side never reflects, and must not inherit the sign that says image
  space does.** `effectiveFocalLength` is negative after an odd number of mirrors
  because image space genuinely runs backwards; the object space was crossed
  before the light ever met a mirror, so the object-space focal length takes that
  sign back out. Without it the **front principal plane of a one-mirror system
  lands on the plane where the magnification is −1** — an *anti*-principal plane,
  which is a real thing and the wrong one. Found on `Dyson1959.zmx`, whose object
  and image both sit inside a block of fused silica; OpticStudio puts both
  principal planes together at 989.720 mm past the first vertex and Isaac put the
  front one at −35.910, which is exactly where OpticStudio's anti-principal plane
  is. `paraxial.test.ts` pins it by the **definition** — place the object at the
  front principal plane and the magnification must be +1 — so the test needs no
  second program to be right.

  All three coincide in air, so nothing in the corpus could tell them apart until `7301707.zmx`, an immersion lithography objective with **water** between its last surface and the wafer, where Isaac reported 5198.311 mm against OpticStudio's 3895.847 — a ratio of 1.334321, water's index at 550 nm to the last digit. The **principal planes** are positions on the axis, so each takes the focal length of the space it lives in rather than the EFL; using the EFL for the front one put it a whole `(n'−n)/φ` into image space, which in air is zero and was therefore invisible too.

  **`BFD` is not OpticStudio's "Back Focal Length"**, and the difference is definitional rather than a fault on either side. Isaac's is the geometric distance from the last surface's vertex to the rear focus — verified against a real ray on that same file to 0.003 mm in 1301. OpticStudio measures image-space distances **from the image surface** and **divides the index out**, which its own Cardinal Points block states in as many words; on that file its 974.011 is Isaac's 1301.438 with the 1.7936 mm of water subtracted and the rest divided by 1.334321. Every cardinal point agrees once both conventions are applied.
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

Implemented today: plane, spherical, conic, even-aspheric and **tilted** surfaces, Snell refraction, mirrors
(traced, paraxially analyzed, and drawn), **coordinate transforms**, **surface apertures and
obscurations — circular, rectangular and elliptical**, sequential tracing, and first-order/paraxial
analysis. Surface types are
`OBJECT`/`STANDARD`/`EVEN_ASPHERE`/`PARAXIAL`/`TILTED`/`COORDINATE_TRANSFORM`/`IMAGE`, with reflection a
flag on a surface rather than a type of its own.

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

Eight kinds are modeled (`model/aperture.ts`), in three families. The **circular** family is bounded by
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

- **A section is cut through the piece, not through the parent's axis.** `outlineInLocalFrame` samples
  along the view's upright axis at the aperture's center on the *other* transverse axis, and takes the
  sag from the sampled point's radial distance rather than from its height in the view. Cutting at
  zero instead drew a slice of the parent surface: in the X–Z view of the Gregorian the mirror
  appeared as a shallow curve near the parent's vertex while the rays met the real piece far down the
  paraboloid, and the light visibly missed the mirror. (A 2-D layout is a **cross-section**, not a
  projection — the projection of any curved patch is a 2-D region, which is not what a lens drawing
  has ever meant.)
- **The aperture is the drawn extent where it is the smaller statement, or the only one.** `drawnDisc`
  in `lib/layout.ts` takes the radius *and the center* from the aperture, but never draws a surface
  larger than a stated semi-diameter: `Schmidt-Cassegrain spider obscuration.zmx` carries
  `CLAP 4 1e+10`, which is how a file writes an annulus with no outer limit, and taking that as the
  extent drew the surface ten billion inches tall and squeezed a 92-inch telescope into a vertical
  line. Where the semi-diameter states nothing — `DIAM 0`, the off-axis case — the aperture is all
  there is. Drawing the semi-diameter instead would draw the parent disc — a mirror nobody has,
  straddling the axis the design exists to keep clear. An obscuration is the exception and falls
  through, since it is something in the way of a surface rather than the bound of one.
- **A stop can have no size of its own.** That file's stop is a bare plane whose pupil is declared by
  `ENPD`, so `entrancePupilPlaneZ` finds the pupil *plane* without asking how big the stop is — only
  the ray from the stop's center is needed for that, and it starts on the axis whatever the size.
  `entrancePupil` still refuses to invent a radius. When the stop does have a size, `stopRadius`
  takes it from the **aperture** first and the semi-diameter second: a stop whose `CLAP` says 25 mm is
  a 25 mm stop however large the surface is drawn.

**What an aperture blocks is drawn too, opaque and black.** `obscurationGeometry` builds the region an
obscuration covers — a disc, a rectangle, an ellipse, or a spider's vanes — from the same
`patchOver` mesh the surface itself uses, so the two cannot disagree about where a decentered
aperture sits. Black rather than a theme token, and deliberately: it is the one thing in the picture
light does not get through, every other material there being translucent or metallic, and it is the
only mark that means the same in both themes without being given two values. **A surface whose only job is to obscure is drawn as the obscuration and nothing else**: the dummy
plane carrying a Schmidt-Cassegrain's spider has no glass, no coating and no rim, its semi-diameter
is a number the program computed, and a disc drawn there puts a pane in the beam that does not
exist. Removing it is also what removes the z-fighting rather than papering over it — with no shell
the vanes have nothing to be coplanar *with*. A surface that does something besides obscure keeps its
shell: a mirror with a spot painted on it is still a mirror, and for that case the material carries
`polygonOffset`, since the spot does lie exactly on the mirror and the depth buffer cannot choose
between them.

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

**The spider is a third family**, being neither a boundary nor a size: `SPIDER` (`SPID`) is
`armCount` vanes of `armWidth`, at equal angles, **the first along the local +x axis** — which is why
a file that wants one at another angle rotates it with a coordinate break rather than with an angle
of its own. It obscures rather than bounds, so the surface keeps its own extent.

**`SPID` is written `width numarms`, the reverse of Chapter 29's `SPID numarms width`** — the one
place in the corpus where the manual's argument *order* is wrong, and worth knowing because the rest
of it has been reliable. The file `Schmidt-Cassegrain spider obscuration.zmx` writes `SPID 2 3` and
OpticStudio shows that surface as 3 arms, 2 wide; read the manual's way, `sc_spatial3.zmx` would have
a single arm three units across a surface whose semi-diameter is 2 — an arm wider than the aperture
it crosses.

The live gap now is **`UDAD`**, a polygon of points listed in the file under the name of a separate
`.UDA`. It is a different *shape* rather than a different size, so it belongs as its own kind rather
than as a case of these; until it lands it stays in `UNMODELED_SURFACE_TOKENS`, warned about per
surface.

**`SCBD` is a tilt/decenter carried on the surface itself**, and it is the other live gap. OpticStudio
offers the same fold two ways: as `COORDBRK` surfaces written into the prescription, which Isaac
models, or as a surface *property* — the Tilt/Decenter tab — which writes `SCBD` and adds no rows.
The manual in `SupportingMaterial/` predates it, so it is not in Chapter 29's keyword table.

Only **7 of the 471 sample files** carry one, 18 records in all, which is why this went unnoticed: it
was landing in `ignoredTokens` with the annotation, so a 45° fold mirror imported as a plate square
to the axis, traced perfectly, and was the wrong system. It is now in `UNMODELED_SURFACE_TOKENS` and
warned about per surface — the honest state until it is modeled.

The record reads `SCBD <group> <order> <mode> [dx dy tx ty tz]`, decoded from the corpus and
corroborated by an independent source (see below), **not from the manual**:

- **Group 1 is "before surface", group 2 is "after".** The five floats are decenter x, decenter y and
  the tilts about x, y and z in degrees — the same five quantities in the same order and units as
  `COORDBRK`'s `PARM 1`–`PARM 5`, and `order` is the same flag as its `PARM 6`.
- **Group 2's `mode` says where its numbers come from**: 0 explicit, 1 pick up this surface (the
  values echo group 1 — the fold-mirror idiom), 2 reverse this surface (the floats are written `-0`
  and mean nothing). `Sample Spectrometer.ZMX` writes the reverse out by hand instead, with the order
  flag flipped and the z tilt negated, which is exactly the round trip the `COORDBRK` tests pin.
- **Group 3 appears only on `COORDBRK` surfaces** and carries no floats: `SCBD 3 <mode> <surface>` is
  the coordinate break's own "return to surface" link. In `double-pass_all misalignments.ZMX` surfaces
  16, 18, 20, 22 and 24 return to 10, 9, 5, 4 and 1 — a return path undoing its outgoing tilts.

**The way in is the frame chain, not a new geometry.** Groups 1 and 2 are a pair of coordinate breaks
bracketing the surface, so `poseAt(i)` gains a transform before the surface is placed and another
before the thickness advances; nothing else in the model has to learn about it. What must not be done
is to expand `SCBD` into extra `COORDINATE_TRANSFORM` *rows*: the rows are what the file does not
have, the surface numbering is what a `.zmx` refers to, and a round trip would come back three
surfaces longer than it went in.

Confirmed against **`SupportingMaterial/Convert Zemax to Code V - French.pdf`** — Joël Boyadjian's
2012 SFO talk on ORA's `zemaxtocv` macro, which reviews the same format from the other side. Its
slide 18 names `SCBD` as the file keyword for the properties-menu tilt, calls it "an attribute of a
surface, and not a surface type", gives a fold mirror as the use, and records that **ORA's own
official converter does not support it** and that exporting in absolute coordinates does not work
around it. Its slide 17 independently confirms what this repo says about `TILTSURF` — the surface's
*frame* is not tilted, the tilt is in the surface equation, and it is what prisms are written with —
and slide 14 confirms `COORDBRK` order 0 as "translate x and y, then rotate about x, the new y, the
new z, in degrees".
