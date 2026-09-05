# Test fixtures

`doublet.zmx` is a hand-written file in the ZMX layout, carrying the prescription of
the classic crown/flint doublet distributed as a sample with
[PyZDDE](https://github.com/xzos/PyZDDE) (`ZMXFILES/Doublet.ZMX`, MIT license). The
token structure — record order, indentation of surface records, padded `WAVM`
list, trailing `TOL`/`MNUM`/`MOFF` metadata — mirrors what Zemax actually writes,
so the reader is exercised against realistic input rather than a tidy invention.

The `.zmx` format has no public specification: it was dropped from the Zemax help
system around 2005. The token meanings this reader relies on were taken from
observed files and cross-checked against open-source readers (Optiland, rayopt).
Treat any token not listed in `HANDLED_HEADER_TOKENS` / `HANDLED_SURFACE_TOKENS`
in `src/import.ts` as unverified — it is reported in `ignoredTokens` rather than
guessed at.

`prescription.txt` is a hand-built **System/Prescription Data** report for that same
doublet, in the layout OpticStudio writes: tab-separated columns, `OBJ`/`STO`/`IMA`
in the Surf column, digits masked with `X` past the third decimal, and the sections
that follow the surface table — including `EDGE THICKNESS DATA`, whose rows have the
same shape as surface rows and were read as 328 extra surfaces by the first version
of the parser.

**It is a fixture for the format, not an independent oracle.** Its optical values were
computed by Isaac and rounded the way the report rounds, so a test using it can show
that the reader and the comparison are wired up correctly — but it cannot show that
Isaac's optics are right, because it has no other source. Only a real export can do
that, and the corpus those live in is gitignored. The tests that check a *convention*
(`prescription.test.ts`, the immersed singlet) therefore build their report by hand
from numbers derived on paper instead.

One value in it is deliberately wrong: surface 3 is given an `r⁴` aspheric coefficient
the doublet does not have. That is what lets the test assert a disagreement is
**caught**, rather than only that agreement is reported — a comparison that quietly
skipped a row would otherwise pass.
