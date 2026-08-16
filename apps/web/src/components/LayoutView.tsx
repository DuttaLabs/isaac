import { useMemo } from 'react';
import type { OpticalSystem } from '@isaac/optical-core';
import { buildLayout, toPath, type LayoutPoint } from '../lib/layout.ts';
import type { LayoutTrace } from '../lib/analysis.ts';
import { wavelengthStyle } from '../lib/wavelengths.ts';

const WIDTH = 900;
const HEIGHT = 340;
const PADDING = 18;

/**
 * Meridional cross-section: the y–z plane a lens designer reads. Scaling is
 * uniform in both axes, so shapes are true rather than stretched to fill.
 */
export function LayoutView({
  system,
  traces,
  defaultSemiDiameter,
}: {
  system: OpticalSystem;
  traces: readonly LayoutTrace[];
  defaultSemiDiameter: number;
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
          fill="var(--glass-fill)"
          stroke="none"
        />
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

      {geometry.profiles.map((profile) => (
        <path
          key={`surface-${profile.surfaceIndex}`}
          d={toPath(profile.points, project)}
          fill="none"
          stroke="var(--glass-stroke)"
          strokeWidth={profile.isImage ? 2 : 1.5}
        />
      ))}

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
