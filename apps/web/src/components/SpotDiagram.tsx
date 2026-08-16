import type { SpotData } from '../lib/analysis.ts';
import { chooseLengthUnit, linearScale, markerPath, niceTicks } from '../lib/plot.ts';
import { wavelengthStyle } from '../lib/wavelengths.ts';

const SIZE = 340;
const MARGIN = { top: 12, right: 12, bottom: 30, left: 46 };

/**
 * Where a grid of pupil rays lands at the image surface, relative to the chief
 * ray. Geometric only — diffraction is outside the engine's scope, so there is
 * deliberately no Airy disc drawn here.
 */
export function SpotDiagram({ data, title }: { data: SpotData; title: string }) {
  const extent = Math.max(data.maxRadius, 1e-6) * 1.15;
  const unit = chooseLengthUnit(extent);
  const limit = extent * unit.scale;

  const x = linearScale([-limit, limit], [MARGIN.left, SIZE - MARGIN.right]);
  const y = linearScale([-limit, limit], [SIZE - MARGIN.bottom, MARGIN.top]);
  const ticks = niceTicks(-limit, limit, 4);

  return (
    <figure style={{ margin: 0 }}>
      <svg className="plot" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={title}>
        {ticks.map((tick) => (
          <g key={`grid-${tick}`}>
            <line
              className="grid-line"
              x1={x(tick)}
              y1={MARGIN.top}
              x2={x(tick)}
              y2={SIZE - MARGIN.bottom}
            />
            <line
              className="grid-line"
              x1={MARGIN.left}
              y1={y(tick)}
              x2={SIZE - MARGIN.right}
              y2={y(tick)}
            />
            <text className="tick-text" x={MARGIN.left - 5} y={y(tick) + 3} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}

        <line className="axis-line" x1={MARGIN.left} y1={y(0)} x2={SIZE - MARGIN.right} y2={y(0)} />
        <line className="axis-line" x1={x(0)} y1={MARGIN.top} x2={x(0)} y2={SIZE - MARGIN.bottom} />

        {data.series.map((series) => {
          const style = wavelengthStyle(series.wavelengthNm, series.wavelengthIndex);
          return (
            <g key={series.wavelengthIndex} fill={style.color} opacity={0.85}>
              {series.points.map((point, index) => (
                <path
                  key={index}
                  d={markerPath(style.marker, x(point.x * unit.scale), y(point.y * unit.scale), 4)}
                />
              ))}
            </g>
          );
        })}

        <text className="axis-title" x={SIZE / 2} y={SIZE - 4} textAnchor="middle">
          Image-plane offset ({unit.suffix})
        </text>
      </svg>
    </figure>
  );
}
