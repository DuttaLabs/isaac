import { useMemo } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import { buildLayout, toPath, type GlassBody, type LayoutPoint } from '../lib/layout.ts';
import type { LayoutTrace } from '../lib/analysis.ts';
import { wavelengthStyle } from '../lib/wavelengths.ts';

const WIDTH = 900;
const HEIGHT = 340;
const PADDING = 18;

/** Says which element is impossible and by how much, on hover. */
function crossedMessage(body: GlassBody, units: string): string {
  return (
    `Surfaces ${body.frontIndex} and ${body.backIndex} cross: the rear surface passes ` +
    `${Math.abs(body.leastGap).toPrecision(3)} ${units} in front of the front one. ` +
    'Reduce the semi-diameter, or increase the thickness or the radii.'
  );
}

/**
 * Meridional cross-section: the y–z plane a lens designer reads. Scaling is
 * uniform in both axes, so shapes are true rather than stretched to fill.
 */
export function LayoutView({
  system,
  traces,
  defaultSemiDiameter,
  highlightedSurface,
}: {
  system: OpticalSystem;
  traces: readonly LayoutTrace[];
  defaultSemiDiameter: number;
  /** Surface the user is on in the lens table, picked out so the row and the
   *  picture can be read together. */
  highlightedSurface?: number;
}) {
  const geometry = useMemo(
    () => buildLayout(system, traces, defaultSemiDiameter),
    [system, traces, defaultSemiDiameter],
  );

  const multipleWavelengths = new Set(traces.map((trace) => trace.wavelengthIndex)).size > 1;

  const { minZ, maxZ, minY, maxY } = geometry.bounds;
  const spanZ = Math.max(maxZ - minZ, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((WIDTH - 2 * PADDING) / spanZ, (HEIGHT - 2 * PADDING) / spanY);

  const centreY = (minY + maxY) / 2;
  const project = (point: LayoutPoint): { x: number; y: number } => ({
    x: PADDING + (point.z - minZ) * scale,
    y: HEIGHT / 2 - (point.y - centreY) * scale,
  });

  const axisY = project({ z: 0, y: 0 }).y;

  return (
    <svg
      className="layout"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`Layout of ${system.name}, ${system.surfaces.length} surfaces`}
    >
      <line
        className="axis-line"
        x1={PADDING}
        y1={axisY}
        x2={WIDTH - PADDING}
        y2={axisY}
        strokeDasharray="4 4"
      />

      {geometry.bodies.map((body, index) => (
        <path
          key={`body-${index}`}
          d={toPath(body.points, project, true)}
          fill={body.crossed ? 'var(--glass-fill-crossed)' : 'var(--glass-fill)'}
          stroke="none"
        >
          {body.crossed ? <title>{crossedMessage(body, system.units)}</title> : null}
        </path>
      ))}

      {geometry.rayPaths.map((path, index) => {
        const style = wavelengthStyle(
          system.wavelengthsNm[path.wavelengthIndex] ?? 550,
          path.wavelengthIndex,
        );
        // Rays are drawn solid when only one wavelength is on screen: with
        // nothing to tell apart, a dash pattern just reads as a broken ray.
        const dash = multipleWavelengths ? style.dash : undefined;
        return (
          <path
            key={`ray-${index}`}
            d={toPath(path.points, project)}
            fill="none"
            stroke={style.color}
            strokeWidth={1}
            strokeDasharray={dash}
            opacity={path.blocked ? 0.25 : 0.85}
          />
        );
      })}

      {/*
        The ground edges close each element top and bottom. They are drawn with
        the profiles rather than with the fill so they sit above the rays, like
        the surfaces they join. A crossed element gets none: there is no edge to
        draw when the surfaces have passed through each other, and its absence
        is a second cue beside the colour, which nobody should have to rely on
        alone.
      */}
      {geometry.bodies.flatMap((body, index) =>
        body.crossed
          ? []
          : [body.topEdge, body.bottomEdge].map((edge, side) => (
              <path
                key={`edge-${index}-${side}`}
                d={toPath(edge, project)}
                fill="none"
                stroke="var(--glass-stroke)"
                strokeWidth={1.5}
              />
            )),
      )}

      {geometry.profiles.map((profile) => {
        // Drawn heavier as well as coloured: the highlight has to survive being
        // one thin line among many, and weight carries where a hue may not.
        const highlighted = profile.surfaceIndex === highlightedSurface;
        return (
          <path
            key={`surface-${profile.surfaceIndex}`}
            d={toPath(profile.points, project)}
            fill="none"
            stroke={highlighted ? 'var(--surface-highlight)' : 'var(--glass-stroke)'}
            strokeWidth={highlighted ? 3 : profile.isImage ? 2 : 1.5}
          />
        );
      })}

      {/* Stop markers: short bars just outside the clear aperture. */}
      {geometry.profiles
        .filter((profile) => profile.isStop)
        .map((profile) => {
          const top = profile.points[profile.points.length - 1]!;
          const bottom = profile.points[0]!;
          return [top, bottom].map((point, side) => {
            const projected = project(point);
            const direction = side === 0 ? -1 : 1;
            return (
              <line
                key={`stop-${profile.surfaceIndex}-${side}`}
                x1={projected.x}
                y1={projected.y}
                x2={projected.x}
                y2={projected.y + direction * 10}
                stroke="var(--stop-mark)"
                strokeWidth={2.5}
              />
            );
          });
        })}
    </svg>
  );
}
