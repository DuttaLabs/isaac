# Test fixtures

`doublet.zmx` is a hand-written file in the ZMX layout, carrying the prescription of
the classic crown/flint doublet distributed as a sample with
[PyZDDE](https://github.com/xzos/PyZDDE) (`ZMXFILES/Doublet.ZMX`, MIT licence). The
token structure — record order, indentation of surface records, padded `WAVM`
list, trailing `TOL`/`MNUM`/`MOFF` metadata — mirrors what Zemax actually writes,
so the reader is exercised against realistic input rather than a tidy invention.

The `.zmx` format has no public specification: it was dropped from the Zemax help
system around 2005. The token meanings this reader relies on were taken from
observed files and cross-checked against open-source readers (Optiland, rayopt).
Treat any token not listed in `HANDLED_HEADER_TOKENS` / `HANDLED_SURFACE_TOKENS`
in `src/import.ts` as unverified — it is reported in `ignoredTokens` rather than
guessed at.
