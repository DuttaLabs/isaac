# ZMX files

Real `.zmx` lens files, kept in the repository so there is always something to
drop onto the app — and so the reader is exercised against files Zemax actually
wrote rather than the tidy fixture in
`packages/zemax-io/tests/fixtures/doublet.zmx`.

These are example *inputs*, not test fixtures: nothing here is asserted against.
A file whose import needs pinning should get a trimmed copy under the owning
package's `tests/fixtures/`, with its expected values written down.

Every file here imports and traces. Files that do not are kept out on purpose:
an example that errors on load teaches nothing about the design and only makes
the app look broken.

## Provenance

| Files | Source | License |
| --- | --- | --- |
| `UK565851-1.zmx` | [lens-designs.com](https://www.lens-designs.com/) — Daniel J. Reiley's exchange of models built from patent literature | MIT |
| the other 30 | [LensLibrary](https://github.com/nzhagen/LensLibrary) — Nathan Hagen's collection, each design paired with its patent | MIT/X |

Numeric filenames are patent numbers; a trailing letter distinguishes
embodiments within one patent. Each file carries its own license text in its
`NOTE` records — keep those intact when adding or editing a file, since they are
the only in-file record of where a design came from.

## The set

Spanning 1897 (`528155`) to 2016 (`Yang2016a`), 8 to 31 surfaces. Focal lengths
of 1.0 and 100 are normalizations, not millimeters — patent literature quotes
prescriptions scaled to a round focal length.

| File | Surfaces | EFL | Fields | Wavelengths |
| --- | --- | --- | --- | --- |
| `528155.zmx` | 11 | 239.89 | 3 | 3 |
| `895045a.zmx` | 9 | 93.20 | 3 | 3 |
| `895045b.zmx` | 9 | 79.43 | 3 | 3 |
| `1791276.zmx` | 12 | 99.76 | 3 | 3 |
| `1792917.zmx` | 13 | 100.25 | 3 | 3 |
| `1843519.zmx` | 8 | 99.97 | 3 | 1 |
| `1975678.ZMX` | 13 | 92.55 | 3 | 3 |
| `1998704a.zmx` | 12 | 100.03 | 3 | 3 |
| `1998704b.zmx` | 11 | 100.44 | 3 | 3 |
| `2031792a.zmx` | 11 | 66.48 | 3 | 3 |
| `2031792b.zmx` | 11 | 78.93 | 3 | 3 |
| `2076190.zmx` | 10 | 101.37 | 3 | 1 |
| `2117252a.zmx` | 13 | 100.59 | 3 | 3 |
| `2453260.zmx` | 9 | 100.00 | 3 | 3 |
| `2645156.zmx` | 11 | 100.02 | 3 | 3 |
| `4037934a.zmx` | 16 | 1.00 | 0 | 3 |
| `5852515a.zmx` | 9 | 299.99 | 3 | 3 |
| `5852515b.zmx` | 13 | 299.99 | 3 | 3 |
| `5852515c.zmx` | 13 | 200.00 | 3 | 3 |
| `6016226.zmx` | 31 | 1.00 | 3 | 3 |
| `7643216a.zmx` | 17 | 50.68 | 3 | 3 |
| `7643216b.zmx` | 13 | 100.47 | 3 | 3 |
| `7643216c.zmx` | 17 | 80.00 | 3 | 3 |
| `7643216d.zmx` | 15 | 67.25 | 3 | 3 |
| `7821720a.zmx` | 16 | 0.96 | 4 | 1 |
| `7821720b.zmx` | 15 | 0.95 | 4 | 1 |
| `7821720c.zmx` | 15 | 1.28 | 4 | 1 |
| `Liang2002a.zmx` | 18 | 104.89 | 3 | 1 |
| `Miyamoto1964.zmx` | 19 | 8.00 | 3 | 1 |
| `Yang2016a.zmx` | 18 | 15.99 | 4 | 3 |
| `UK565851-1.zmx` | 11 | 25.35 | 3 | 3 |

Nearly all of the LensLibrary designs specify glass as an index and Abbe number
rather than by name, so they exercise the model glass; see `CLAUDE.md`. Their
paraxial focus lands within 0.1 % of the focal length of the image plane the
file itself carries, for 25 of the 30 — an independent check that the model
glass reproduces the designer's optics. The exceptions are the very wide-field
designs (`7821720*` reach 85°, `6016226`), where the image plane is a
compromise balanced across the field rather than the axial best focus.

## What is *not* here

47 of LensLibrary's 77 files were left out because Isaac cannot yet model them:
even aspheres and conics (21 files), ideal `PARAXIAL` surfaces and coordinate
transforms (13, mostly the spectrometer designs), and glasses outside the SCHOTT
catalog such as CAF2, OHARA `S-` types and fused silica (11). Re-run the
triage after adding any of those and this directory can grow.

## `UK565851-1.zmx` in particular

A useful stress test rather than a clean one:

- It is **UTF-16** with CRLF line endings, so it exercises `decodeZmx`.
- It names **`SK16`**, a discontinued glass. The app has `allowLegacyNames` on,
  so it traces SCHOTT's lead-free `N-SK16` instead and says so in a warning.
  That substitution matches nd/vd but not the fourth decimal of the index.
- It carries **33 record types the reader does not model** — notes, tolerancing,
  display flags, physical-optics settings. That is normal for a real file and
  says nothing about whether the prescription imported correctly; see the
  `zemax-io` section of `CLAUDE.md`.
- Its image plane sits **~0.26 mm short of paraxial focus**, which is the
  designer's chosen best-focus plane, not an import error: the ray fan is about
  half as wide there as at the paraxial image.
