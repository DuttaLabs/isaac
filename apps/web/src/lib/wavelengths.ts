/**
 * Wavelength styling.
 *
 * Color follows the physics — the F line reads blue, the d line green, the C
 * line red — which is the convention every lens-design tool uses. That palette
 * is drawn from validated ramp steps, but blue/green/red sits in the 6–8 ΔE
 * band under protanopia, so color is never the only cue: every series also
 * carries a dash pattern (lines) and a marker shape (points), and the legend is
 * always on screen with the wavelength in nanometers.
 */

export interface WavelengthStyle {
  /** CSS custom property holding the color for the current theme. */
  color: string;
  /** SVG stroke-dasharray; `undefined` means solid. */
  dash: string | undefined;
  marker: 'circle' | 'square' | 'triangle' | 'diamond';
  label: string;
}

const SPECTRAL_BANDS: readonly { maxNm: number; variable: string }[] = [
  { maxNm: 500, variable: '--wave-blue' },
  { maxNm: 600, variable: '--wave-green' },
  { maxNm: Infinity, variable: '--wave-red' },
];

/** Extra cues, indexed by position in the wavelength list. */
const DASHES: readonly (string | undefined)[] = [undefined, '7 4', '2 3', '10 3 2 3', '1 4'];
const MARKERS: readonly WavelengthStyle['marker'][] = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'circle',
];

export function wavelengthStyle(wavelengthNm: number, index: number): WavelengthStyle {
  const band =
    SPECTRAL_BANDS.find((candidate) => wavelengthNm <= candidate.maxNm) ?? SPECTRAL_BANDS[2]!;
  return {
    color: `var(${band.variable})`,
    dash: DASHES[index % DASHES.length],
    marker: MARKERS[index % MARKERS.length]!,
    label: `${wavelengthNm.toFixed(1)} nm`,
  };
}
