// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run regenerate-renames --workspace @isaac/glass-catalog -- <path to .AGF>
//
// Source: SCHOTT June 2025 preferred, inquiry, AR glasses
//
// Names SCHOTT has retired, each paired with the glass in `schott.ts` whose
// dispersion matches. The pairing is not a guess from the spelling: it was
// verified by comparing SCHOTT's published fit for the old name against the
// modern glass, and only pairs agreeing to better than 5e-5 across
// 450–650 nm are here. Where more than one modern glass is that close — the
// catalog has real near-duplicates, such as N-BK7 and N-BK7HT — the pair is
// only kept when SCHOTT's own renaming rule picks the same one.
//
// These are *aliases*, not substitutions: resolving one is exact across the
// visible, where a substitution guessed from the spelling can be a different
// glass entirely — see GlassCatalogOptions.allowLegacyNames. But note that only
// about half the pairs carry bit-identical coefficients; for the rest SCHOTT
// publishes two fits that agree in the visible and drift by up to 4e-3 at the
// edges of the published range, so the alias is not exact outside 450–650 nm.

/** 50 retired SCHOTT names, each with the current name for the same glass. */
export const SCHOTT_RENAMES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ['BAF51', 'N-BAF51'],
  ['BAF52', 'N-BAF52'],
  ['BAFN10', 'N-BAF10'],
  ['BAK1', 'N-BAK1'],
  ['BAK2', 'N-BAK2'],
  ['BAK4', 'N-BAK4'],
  ['BALF5', 'N-BALF5'],
  ['BASF64A', 'N-BASF64'],
  ['BK10', 'N-BK10'],
  ['BK7', 'N-BK7'],
  ['FK5', 'N-FK5'],
  ['FK51', 'N-FK51'],
  ['K5', 'N-K5'],
  ['K5HT', 'N-K5'],
  ['K7HT', 'K7'],
  ['KF9', 'N-KF9'],
  ['KZFS8', 'N-KZFS8'],
  ['KZFSN2', 'N-KZFS2'],
  ['KZFSN5', 'N-KZFS5'],
  ['LAF3', 'N-LAF3'],
  ['LAK10', 'N-LAK10'],
  ['LAK21', 'N-LAK21'],
  ['LAK8', 'N-LAK8'],
  ['LAK9', 'N-LAK9'],
  ['LAKL21', 'N-LAK21'],
  ['LAKN12', 'N-LAK12'],
  ['LAKN13', 'P-LAK35'],
  ['LAKN14', 'N-LAK14'],
  ['LAKN22', 'N-LAK22'],
  ['LAKN7', 'N-LAK7'],
  ['LASFN31', 'N-LASF31'],
  ['N-PK52', 'N-PK52A'],
  ['PK51A', 'N-PK51'],
  ['PSK3', 'N-PSK3'],
  ['PSK53A', 'N-PSK53'],
  ['SF6HT', 'SF6'],
  ['SF8', 'P-SF8'],
  ['SFL56', 'N-SF56'],
  ['SK10', 'N-SK10'],
  ['SK11', 'N-SK11'],
  ['SK14', 'N-SK14'],
  ['SK15', 'N-SK15'],
  ['SK16', 'N-SK16'],
  ['SK2', 'N-SK2'],
  ['SK4', 'N-SK4'],
  ['SK5', 'N-SK5'],
  ['SK55', 'N-SK16'],
  ['SSKN5', 'N-SSK5'],
  ['SSKN8', 'N-SSK8'],
  ['ZKN7', 'N-ZK7'],
];
