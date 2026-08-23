import type { Field } from '@isaac/optical-core';

/**
 * Field styling for the layout views.
 *
 * The layout is a *spatial* picture, and the series in it are the field bundles:
 * each leaves at its own angle and converges at its own image height. So color
 * there follows the field, and wavelength moves to the dash pattern. The ray-fan
 * and spot panels keep the opposite mapping — they draw one field at a time, so
 * wavelength is their series and its F-blue / d-green / C-red convention stands.
 *
 * The color is keyed on the field's index in the **system**, never on its
 * position among the fields currently drawn: switching one off with the Display
 * checkboxes must not repaint the survivors.
 *
 * The six hues are steps from the same validated ramps the wavelength colors
 * come from, ordered so that the first three — which cover all but a handful of
 * real designs — are the three that also clear 3:1 against the light surface,
 * and so that the two hues the first-order overlay uses (violet and orange) come
 * last, where a design is very unlikely to reach them. The order passes the
 * adjacent-pair colorblind and normal-vision gates in both themes; the residual
 * warnings sit in the band that is allowed with a second cue, which is why the
 * legend is always on screen and the wavelength dash is kept.
 */

export interface FieldStyle {
  /** CSS custom property reference for the current theme. */
  color: string;
  /**
   * The bare custom-property name behind {@link color}. WebGL needs a resolved
   * value rather than a `var()` reference, so the 3-D view looks it up on the
   * document and follows the theme the same way the SVG view does.
   */
  colorVariable: string;
  /** How the field reads in a legend: `5°`, `12 mm`, or `on axis`. */
  label: string;
}

/**
 * Fixed hue order, never cycled. A design with more fields than this shares one
 * neutral rather than reusing a hue — a repeated color would say two fields are
 * the same thing, and the legend says plainly that the rest are grouped.
 */
export const FIELD_COLOR_VARIABLES: readonly string[] = [
  '--field-1',
  '--field-2',
  '--field-3',
  '--field-4',
  '--field-5',
  '--field-6',
];

export const FIELD_OVERFLOW_VARIABLE = '--field-other';

export function fieldStyle(field: Field | undefined, index: number): FieldStyle {
  const variable = FIELD_COLOR_VARIABLES[index] ?? FIELD_OVERFLOW_VARIABLE;
  return {
    color: `var(${variable})`,
    colorVariable: variable,
    label: fieldLabel(field),
  };
}

/** How a field reads on its own, independent of any styling. */
export function fieldLabel(field: Field | undefined): string {
  if (field?.angleDeg !== undefined) {
    return `${Number(field.angleDeg.toFixed(4))}°`;
  }
  if (field?.objectHeight !== undefined) {
    return `${Number(field.objectHeight.toFixed(4))} height`;
  }
  return 'on axis';
}
