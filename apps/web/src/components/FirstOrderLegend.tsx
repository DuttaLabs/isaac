import type { PrincipalPlanes, PupilMark } from './LayoutView.tsx';
import type { FirstOrderRays } from '../lib/analysis.ts';
import { formatLength } from '../lib/format.ts';

/**
 * Names the four things the first-order overlay draws, and says what each one
 * is *for* — which is the point of the overlay. A beginner can see two extra
 * lines on the picture without the drawing alone telling them that one is the
 * ray that meets the aperture and the other the ray that meets the field.
 *
 * The swatch repeats the dash pattern as well as the color, so the legend works
 * for a reader who cannot separate the two hues.
 */
export function FirstOrderLegend({
  rays,
  entrance,
  exit,
  principal,
  units,
}: {
  rays: FirstOrderRays | undefined;
  entrance: PupilMark | undefined;
  exit: PupilMark | undefined;
  principal: PrincipalPlanes | undefined;
  units: string;
}) {
  const items: { key: string; className: string; dash?: string; label: string; title: string }[] =
    [];

  if (rays) {
    items.push({
      key: 'marginal',
      className: 'swatch-marginal',
      label: 'marginal ray (on axis)',
      title:
        'From the axial object point to the rim of the pupil. The ray that meets the aperture: it sets the F/# and where the image lies. Dashed where it is continued undeviated on to the entrance pupil, which is usually a virtual plane no real ray reaches.',
    });
    items.push({
      key: 'chief',
      className: 'swatch-chief',
      dash: '7 4',
      label: `chief ray (${rays.chiefField})`,
      title:
        'From the outermost field point through the center of the pupil. The ray that meets the field: it sets the image height, and how big every element has to be.',
    });
  }

  for (const [key, pupil, label] of [
    ['entrance', entrance, 'entrance pupil'],
    ['exit', exit, 'exit pupil'],
  ] as const) {
    if (!pupil) {
      continue;
    }
    items.push({
      key,
      className: `swatch-${key}`,
      dash: '3 3',
      label: `${label} · ⌀ ${formatLength(2 * pupil.radius)} ${units} at z = ${formatLength(pupil.z)}`,
      title:
        key === 'entrance'
          ? 'The aperture stop as object space sees it. Every ray in the system is aimed at this plane.'
          : 'The aperture stop as image space sees it. The cone converging on the image appears to come from here.',
    });
  }

  if (principal) {
    const where = [
      Number.isFinite(principal.frontZ) ? `P at z = ${formatLength(principal.frontZ)}` : undefined,
      Number.isFinite(principal.rearZ) ? `P′ at z = ${formatLength(principal.rearZ)}` : undefined,
    ].filter(Boolean);
    items.push({
      key: 'principal',
      className: 'swatch-principal',
      dash: '9 5',
      label: `principal planes · ${where.join(', ')} ${units}`,
      title:
        'The pair of unit-magnification planes. A focal length is measured from these, not from the glass — the front focal point lies one focal length before P, the rear one focal length after P′. To first order the whole lens behaves as a thin one placed there.',
    });
  }

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="legend">
      {items.map((item) => (
        <span className="legend-item" key={item.key} title={item.title}>
          <svg width="22" height="10" aria-hidden="true" className={item.className}>
            <line x1="1" y1="5" x2="21" y2="5" strokeWidth="2" strokeDasharray={item.dash} />
          </svg>
          {item.label}
        </span>
      ))}
    </div>
  );
}
