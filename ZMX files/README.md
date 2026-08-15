# ZMX files

Real `.zmx` lens files, kept in the repository so there is always something to
drop onto the app — and so the reader is exercised against files Zemax actually
wrote rather than the tidy fixture in
`packages/zemax-io/tests/fixtures/doublet.zmx`.

These are example *inputs*, not test fixtures: nothing here is asserted against.
A file whose import needs pinning should get a trimmed copy under the owning
package's `tests/fixtures/`, with its expected values written down.

## Provenance

| File | Design | Source |
| --- | --- | --- |
| `UK565851-1.zmx` | UK patent 565 851, ~25 mm f/3.2, 30° half-field, four elements | [lens-designs.com](https://www.lens-designs.com/) |

[lens-designs.com](https://www.lens-designs.com/) is Daniel J. Reiley's file
exchange of Zemax and OSLO models built from patent literature, published under
the MIT licence. Each file carries its own licence text in its `NOTE` records —
keep those intact when adding or editing a file, since they are the only record
of where a design came from.

## What to expect on import

`UK565851-1.zmx` is a useful stress test rather than a clean one:

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
