/** Minimal plotting helpers: a linear scale and readable tick steps. */

export interface Scale {
  (value: number): number;
  domain: readonly [number, number];
  range: readonly [number, number];
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as Scale;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

/** Tick values at 1/2/5×10ⁿ steps, covering the domain without crowding it. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [min];
  }
  const rawStep = (max - min) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude;

  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-6; value += step) {
    // Snap values like 0.30000000000000004 back to something printable.
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

/** Chooses µm or mm depending on how small the values are. */
export function chooseLengthUnit(maxMillimeters: number): { scale: number; suffix: string } {
  return maxMillimeters < 0.2 ? { scale: 1000, suffix: 'µm' } : { scale: 1, suffix: 'mm' };
}

/** SVG path for a marker shape, centered on (x, y). */
export function markerPath(
  marker: 'circle' | 'square' | 'triangle' | 'diamond',
  x: number,
  y: number,
  size: number,
): string {
  const r = size / 2;
  switch (marker) {
    case 'square':
      return `M${x - r} ${y - r} H${x + r} V${y + r} H${x - r} Z`;
    case 'triangle':
      return `M${x} ${y - r} L${x + r} ${y + r} L${x - r} ${y + r} Z`;
    case 'diamond':
      return `M${x} ${y - r} L${x + r} ${y} L${x} ${y + r} L${x - r} ${y} Z`;
    default:
      return `M${x - r} ${y} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
  }
}
