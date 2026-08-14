import type { RayFanData } from '../lib/analysis.ts';
import { chooseLengthUnit, linearScale, niceTicks } from '../lib/plot.ts';
import { wavelengthStyle } from '../lib/wavelengths.ts';

const WIDTH = 340;
const HEIGHT = 240;
const MARGIN = { top: 12, right: 12, bottom: 30, left: 46 };

/**
 * Transverse ray aberration against pupil position. A perfect lens plots a flat
 * line on zero; the shape of the curve is what names the aberration.
 */
export function RayFanPlot({ data, title }: { data: RayFanData; title: string }) {
  const unit = chooseLengthUnit(data.maxError);
  const limit = data.maxError * unit.scale * 1.1;

  const x = linearScale([-1, 1], [MARGIN.left, WIDTH - MARGIN.right]);
  const y = linearScale([-limit, limit], [HEIGHT - MARGIN.bottom, MARGIN.top]);

  const xTicks = [-1, -0.5, 0, 0.5, 1];
  const yTicks = niceTicks(-limit, limit, 4);

  return (
    <figure style={{ margin: 0 }}>
      <svg className="plot" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={title}>
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line
              className="grid-line"
              x1={MARGIN.left}
              y1={y(tick)}
              x2={WIDTH - MARGIN.right}
              y2={y(tick)}
            />
            <text className="tick-text" x={MARGIN.left - 5} y={y(tick) + 3} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}

        {xTicks.map((tick) => (
          <text
            key={`x-${tick}`}
            className="tick-text"
            x={x(tick)}
            y={HEIGHT - MARGIN.bottom + 12}
            textAnchor="middle"
          >
            {tick}
          </text>
        ))}

        <line
          className="axis-line"
          x1={MARGIN.left}
          y1={y(0)}
          x2={WIDTH - MARGIN.right}
          y2={y(0)}
        />
        <line
          className="axis-line"
          x1={x(0)}
          y1={MARGIN.top}
          x2={x(0)}
          y2={HEIGHT - MARGIN.bottom}
        />

        {data.series.map((series) => {
          const style = wavelengthStyle(series.wavelengthNm, series.wavelengthIndex);
          if (series.points.length < 2) {
            return null;
          }
          const path = series.points
            .map(
              (point, index) =>
                `${index === 0 ? 'M' : 'L'}${x(point.pupil).toFixed(2)} ${y(point.error * unit.scale).toFixed(2)}`,
            )
            .join(' ');
          return (
            <path
              key={series.wavelengthIndex}
              d={path}
              fill="none"
              stroke={style.color}
              strokeWidth={2}
              strokeDasharray={style.dash}
              strokeLinecap="round"
            />
          );
        })}

        <text className="axis-title" x={WIDTH / 2} y={HEIGHT - 4} textAnchor="middle">
          Pupil position P<tspan baselineShift="sub">y</tspan>
        </text>
        <text
          className="axis-title"
          x={12}
          y={HEIGHT / 2}
          textAnchor="middle"
          transform={`rotate(-90 12 ${HEIGHT / 2})`}
        >
          Ray error ({unit.suffix})
        </text>
      </svg>
    </figure>
  );
}
