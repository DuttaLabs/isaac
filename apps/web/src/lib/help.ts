/**
 * Asking Isaac's own help assistant a question, and telling it what is on
 * screen when the question is asked.
 *
 * The second half is the point. A help system that has read the manual can
 * answer "what does the Aperture column do"; one that can also see the design
 * can answer "why are my rays blocked", which is the question people actually
 * have. Isaac holds the whole system as plain data, so the answer costs a
 * summary rather than an integration.
 *
 * No key lives here, and none can: a key in a bundle is a key anybody can read
 * out of the JavaScript. The browser asks Isaac's own server, which holds the
 * key and does the spending. This module knows a URL and nothing else.
 */

import type { OpticalSystem, Surface } from '@isaac/optical-core';

import type { FirstOrder } from './analysis.ts';
import type { Result } from './result.ts';

const env = import.meta.env as Record<string, string | undefined>;

/**
 * Where to ask.
 *
 * Derived from the session URL rather than written down a second time — it is
 * the same server, and two spellings of one hostname is one spelling that can
 * be forgotten on a deploy. `wss:` becomes `https:` because the socket and the
 * request differ only in scheme.
 */
function helpUrl(): string {
  const explicit = env['VITE_HELP_URL'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const session = env['VITE_SESSION_URL'] ?? 'wss://api.isaacoptics.com/';
  const url = new URL(session);
  url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  url.pathname = '/help';
  url.search = '';
  return url.toString();
}

export const HELP_URL: string = helpUrl();

const TOKEN: string | undefined = env['VITE_SESSION_TOKEN'] || undefined;

/** One question and the answer it got. */
export interface Exchange {
  readonly question: string;
  readonly answer: string;
}

/**
 * How many earlier exchanges to send. The server trims to its own limit
 * regardless — this one only decides what leaves the browser.
 */
export const HISTORY_SENT = 3;

/**
 * Ask, and get an answer or a reason there is none.
 *
 * The token travels in a header here, where the session's travels in the query
 * string. That is not an inconsistency to tidy up: a WebSocket cannot set a
 * header and an ordinary request can, and a secret in a URL is a secret in
 * nginx's access log.
 */
export async function askIsaac(
  question: string,
  context?: string,
  history: readonly Exchange[] = [],
): Promise<Result<string>> {
  try {
    const response = await fetch(HELP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(TOKEN !== undefined && { 'x-isaac-token': TOKEN }),
      },
      body: JSON.stringify({
        question,
        ...(context !== undefined && { context }),
        ...(history.length > 0 && { history: history.slice(-HISTORY_SENT) }),
      }),
    });
    // Never trust the parse. A body that is not what this expects becomes a
    // stated failure rather than `undefined` rendered as an answer.
    const body = (await response.json().catch(() => undefined)) as
      | { answer?: unknown; error?: unknown }
      | undefined;
    if (!response.ok) {
      const stated = typeof body?.error === 'string' ? body.error : undefined;
      return { ok: false, error: stated ?? `The help assistant answered ${response.status}.` };
    }
    if (typeof body?.answer !== 'string') {
      return { ok: false, error: 'The help assistant sent something unreadable.' };
    }
    return { ok: true, value: body.answer };
  } catch {
    // A network failure and a refused request are different things and read
    // differently: this one is "could not reach", not "would not answer".
    return { ok: false, error: 'Could not reach the help assistant. Are you online?' };
  }
}

/** Rounded for reading, and without a trailing `.0` on a whole number. */
function num(value: number, places = 4): string {
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  return String(Number(value.toFixed(places)));
}

/** What a surface's aperture actually is, in one phrase. */
function describeAperture(surface: Surface): string {
  const aperture = surface.aperture;
  if (aperture === undefined) return '';
  switch (aperture.kind) {
    case 'FLOATING':
      return 'floating aperture (radius follows the semi-diameter)';
    case 'SPIDER':
      return `spider, ${aperture.armCount} arms ${num(aperture.armWidth)} wide`;
    case 'CIRCULAR':
    case 'CIRCULAR_OBSCURATION': {
      const what = aperture.kind === 'CIRCULAR' ? 'circular aperture' : 'circular obscuration';
      const inner = aperture.minRadius > 0 ? `${num(aperture.minRadius)}–` : '';
      return `${what} ${inner}${num(aperture.maxRadius)}`;
    }
    default: {
      const round = aperture.kind.startsWith('ELLIPTICAL') ? 'elliptical' : 'rectangular';
      const stops = aperture.kind.endsWith('OBSCURATION') ? 'obscuration' : 'aperture';
      return `${round} ${stops} ${num(aperture.halfWidthX)} × ${num(aperture.halfWidthY)} half-widths`;
    }
  }
}

/**
 * The design as something a language model can read.
 *
 * Deliberately close to the lens grid the user is looking at, column for
 * column: the answer has to be checkable against the screen, and a summary in
 * some private shape of its own would send somebody hunting for a number that
 * is not displayed anywhere. It is also why this is prose and a table rather
 * than JSON — the user may want to read it, and there is a control that shows
 * it to them.
 */
export function describeSystem(
  system: OpticalSystem,
  firstOrder: Result<FirstOrder>,
  extra: { fileName?: string; hiddenSurfaces?: ReadonlySet<number> } = {},
): string {
  const lines: string[] = [];

  lines.push(`Name: ${system.name}`);
  if (extra.fileName !== undefined) lines.push(`File: ${extra.fileName}`);
  lines.push(`Units: ${system.units}`);
  lines.push(
    `Wavelengths (nm): ${system.wavelengthsNm.map(num).join(', ')}` +
      ` — primary ${num(system.primaryWavelengthNm)}`,
  );

  const fields = system.fields
    .map((field, index) =>
      field.angleDeg !== undefined
        ? `${index}: ${num(field.angleDeg)}°`
        : `${index}: height ${num(field.objectHeight ?? 0)}`,
    )
    .join(', ');
  lines.push(`Fields: ${fields || 'none'}`);

  if (system.aperture !== undefined) {
    lines.push(`System aperture: ${system.aperture.type} = ${num(system.aperture.value ?? 0)}`);
  }
  lines.push(`Stop: ${system.stopIndex === undefined ? 'none set' : `surface ${system.stopIndex}`}`);
  // A folded system's first-order numbers describe its unfolded equivalent, and
  // that caveat has to travel with the numbers or the answer will state them flat.
  lines.push(`Centered (no tilts or decenters): ${system.isCentered ? 'yes' : 'no'}`);

  lines.push('');
  lines.push('Surfaces:');
  lines.push('#  type              radius     thickness  semi-dia  material    notes');
  system.surfaces.forEach((surface, index) => {
    const notes: string[] = [];
    if (surface.isStop) notes.push('STOP');
    if (surface.reflective) notes.push('mirror');
    if (surface.conic !== 0) notes.push(`conic ${num(surface.conic)}`);
    if (surface.hasAsphericTerms) notes.push('aspheric terms');
    if (surface.focalLength !== undefined) notes.push(`f = ${num(surface.focalLength)}`);
    if (extra.hiddenSurfaces?.has(index)) notes.push('SWITCHED OUT of the light');
    const aperture = describeAperture(surface);
    if (aperture !== '') notes.push(aperture);
    if (surface.comment !== undefined && surface.comment !== '') notes.push(`"${surface.comment}"`);

    lines.push(
      [
        String(index).padEnd(3),
        surface.type.padEnd(18),
        num(surface.radius).padEnd(11),
        num(surface.thickness).padEnd(11),
        num(surface.semiDiameter).padEnd(10),
        (surface.reflective ? 'MIRROR' : surface.material.name).padEnd(12),
        notes.join('; '),
      ].join('').trimEnd(),
    );
  });

  lines.push('');
  if (firstOrder.ok) {
    const p = firstOrder.value.properties;
    lines.push('First order:');
    lines.push(`  Effective focal length: ${num(p.effectiveFocalLength)}`);
    lines.push(`  Back focal distance: ${num(p.backFocalDistance)}`);
    lines.push(`  Image distance: ${num(p.imageDistance)}`);
    lines.push(`  Magnification: ${num(p.magnification)}`);
    lines.push(`  Entrance pupil radius: ${num(firstOrder.value.entrancePupilRadius)}`);
    if (firstOrder.value.fNumber !== undefined) {
      lines.push(`  F/# : ${num(firstOrder.value.fNumber, 3)}`);
    }
  } else {
    // A refusal is information — "this system has no focal length" is often the
    // answer to the question being asked — so it is passed on rather than
    // dropped as a failed computation.
    lines.push(`First order could not be computed: ${firstOrder.error}`);
  }

  return lines.join('\n');
}
