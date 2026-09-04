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

/**
 * Vite replaces `import.meta.env` at build time and Node leaves it undefined,
 * so this module has to survive being imported outside a bundle — which it now
 * is, by its own tests. Falling back to an empty record means the URL resolves
 * to its default rather than throwing on the import, and a test that only wants
 * `readAction` never has to care where the server is.
 */
const env =
  (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

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
  /** What the assistant asked the app to do, if it asked for anything. */
  readonly action?: HelpAction;
  /** Set once a proposal has been applied or thrown away, so it stops offering. */
  readonly settled?: 'applied' | 'discarded' | 'refused';
  /** Why an apply was refused, which is the engine's own words. */
  readonly problem?: string;
}

/** One before-and-after in a proposal. */
export interface ProposedEdit {
  readonly surface: number;
  readonly property:
    | 'radius' | 'conic' | 'thickness' | 'semiDiameter' | 'material' | 'label' | 'stop' | 'mirror';
  readonly value: string;
}

/**
 * What the assistant can ask the app to do.
 *
 * Ordered by what it costs to be wrong, which is also the order they were
 * built: the first two change nothing, the third is one undo away, and the
 * last does not act at all — it offers, and a person presses Apply.
 */
export type HelpAction =
  | { readonly kind: 'highlight_surface'; readonly surface: number }
  | { readonly kind: 'open_panel'; readonly panel: string }
  | {
      readonly kind: 'load_design';
      readonly zmx: string;
      readonly name: string;
      readonly note: string;
      /**
       * What the assistant says it was aiming for.
       *
       * Isaac traces what actually arrived and holds it against these. A
       * prescription that reads correctly and is the wrong lens is the failure
       * mode here — it imports, it traces, it draws, and it is f/55 when it was
       * meant to be f/5 — and nothing in the file itself can catch that. A
       * stated intent can.
       */
      readonly intendedEfl: number;
      readonly intendedFNumber: number;
    }
  | { readonly kind: 'propose_edits'; readonly edits: readonly ProposedEdit[]; readonly why: string };

const EDIT_PROPERTIES = new Set([
  'radius', 'conic', 'thickness', 'semiDiameter', 'material', 'label', 'stop', 'mirror',
]);

/**
 * An action, or nothing.
 *
 * Checked rather than cast, for the same reason the stored layout is: this
 * arrived over a socket from a model, and a shape that merely type-checks in
 * TypeScript would reach `edits.ts` as `undefined` and fail somewhere with no
 * connection to where it went wrong. An action that does not read cleanly is
 * dropped and the prose is kept — the answer is still worth having.
 */
export function readAction(value: unknown): HelpAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const action = value as Record<string, unknown>;
  switch (action['kind']) {
    case 'highlight_surface':
      return typeof action['surface'] === 'number'
        ? { kind: 'highlight_surface', surface: action['surface'] }
        : undefined;
    case 'open_panel':
      return typeof action['panel'] === 'string'
        ? { kind: 'open_panel', panel: action['panel'] }
        : undefined;
    case 'load_design':
      return typeof action['zmx'] === 'string' &&
        typeof action['name'] === 'string' &&
        typeof action['note'] === 'string' &&
        typeof action['intendedEfl'] === 'number' &&
        typeof action['intendedFNumber'] === 'number'
        ? {
            kind: 'load_design',
            zmx: action['zmx'],
            name: action['name'],
            note: action['note'],
            intendedEfl: action['intendedEfl'],
            intendedFNumber: action['intendedFNumber'],
          }
        : undefined;
    case 'propose_edits': {
      const raw = action['edits'];
      if (!Array.isArray(raw) || raw.length === 0) return undefined;
      const edits: ProposedEdit[] = [];
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) return undefined;
        const { surface, property, value: to } = item as Record<string, unknown>;
        if (typeof surface !== 'number' || typeof property !== 'string' || typeof to !== 'string') {
          return undefined;
        }
        if (!EDIT_PROPERTIES.has(property)) return undefined;
        edits.push({ surface, property: property as ProposedEdit['property'], value: to });
      }
      return {
        kind: 'propose_edits',
        edits,
        why: typeof action['why'] === 'string' ? action['why'] : '',
      };
    }
    default:
      return undefined;
  }
}

/**
 * How many earlier exchanges to send. The server trims to its own limit
 * regardless — this one only decides what leaves the browser.
 */
export const HISTORY_SENT = 3;

/**
 * What an earlier turn should look like when it is sent back as history.
 *
 * Not simply `exchange.answer`, and the difference is a bug that took a log to
 * find. A model calling a tool very often writes no prose at all, so an
 * exchange that *did* something can carry an empty answer — and an empty
 * assistant turn tells the next request that the assistant said nothing. Ask
 * "yes, do that" after a proposal and it reaches a model with no record of
 * having proposed anything.
 *
 * So the action is described in words and travels with the prose. The bracket
 * marks it as a note about what happened rather than something that was said.
 */
export function historyAnswer(exchange: Exchange): string {
  const did = ((): string | undefined => {
    switch (exchange.action?.kind) {
      case 'highlight_surface':
        return `[I highlighted surface ${exchange.action.surface}.]`;
      case 'open_panel':
        return `[I opened the ${exchange.action.panel} panel.]`;
      case 'load_design':
        return `[I loaded a design I wrote, ${exchange.action.name}, aiming for EFL ${exchange.action.intendedEfl} at f/${exchange.action.intendedFNumber}. It replaced what was open.]`;
      case 'propose_edits': {
        const listed = exchange.action.edits
          .map((edit) => `surface ${edit.surface} ${edit.property} to ${edit.value}`)
          .join(', ');
        const outcome =
          exchange.settled === 'applied'
            ? 'The user applied it.'
            : exchange.settled === 'discarded'
              ? 'The user discarded it.'
              : 'It is still waiting for the user to apply or discard it.';
        // Whether it was applied is the fact a follow-up turns on: "yes, do
        // that" means something different depending on whether it is done.
        return `[I proposed: ${listed}. ${outcome}]`;
      }
      default:
        return undefined;
    }
  })();

  const said = exchange.answer.trim();
  if (did === undefined) return said;
  return said === '' ? did : `${said}\n${did}`;
}

/** What an answer turned out to be, once the stream has finished. */
export interface Answered {
  readonly answer: string;
  readonly action?: HelpAction;
}

/**
 * Ask, streaming the prose back as it arrives.
 *
 * Streaming is not a performance trick here — the total time is the same. It is
 * that four seconds of a blank box reads as broken, and four seconds of prose
 * appearing reads as thinking. The action, if there is one, arrives last:
 * a tool call is only complete when the model has finished writing its
 * arguments, so there is nothing honest to hand over sooner.
 *
 * The token travels in a header, where the session's travels in the query
 * string. That is not an inconsistency to tidy up: a WebSocket cannot set a
 * header and an ordinary request can, and a secret in a URL is a secret in
 * nginx\'s access log.
 */
export async function askIsaac(
  question: string,
  context: string | undefined,
  history: readonly Exchange[],
  onText: (soFar: string) => void,
): Promise<Result<Answered>> {
  let response: Response;
  try {
    response = await fetch(HELP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(TOKEN !== undefined && { 'x-isaac-token': TOKEN }),
      },
      body: JSON.stringify({
        question,
        stream: true,
        ...(context !== undefined && { context }),
        ...(history.length > 0 && {
          history: history
            .slice(-HISTORY_SENT)
            .map((turn) => ({ question: turn.question, answer: historyAnswer(turn) }))
            // An assistant turn with nothing in it is refused by the API, and
            // is meaningless to the model in any case.
            .filter((turn) => turn.answer !== ''),
        }),
      }),
    });
  } catch {
    // A network failure and a refused request are different things and read
    // differently: this one is "could not reach", not "would not answer".
    return { ok: false, error: 'Could not reach the help assistant. Are you online?' };
  }

  if (!response.ok || response.body === null) {
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
    const stated = typeof body?.error === 'string' ? body.error : undefined;
    return { ok: false, error: stated ?? `The help assistant answered ${response.status}.` };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let answer = '';
  let action: HelpAction | undefined;
  let failure: string | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });

    // Server-sent events are separated by a blank line, and a chunk boundary
    // can fall anywhere — including inside one. Whatever trails the last
    // separator is an event still arriving, so it stays in the buffer.
    const events = pending.split('\n\n');
    pending = events.pop() ?? '';

    for (const event of events) {
      const line = event.split('\n').find((part) => part.startsWith('data:'));
      if (line === undefined) continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (payload['kind'] === 'text' && typeof payload['text'] === 'string') {
        answer += payload['text'];
        onText(answer);
      } else if (payload['kind'] === 'action') {
        action = readAction(payload['action']);
      } else if (payload['kind'] === 'error' && typeof payload['error'] === 'string') {
        failure = payload['error'];
      }
    }
  }

  // A stream that failed part way still carries whatever prose arrived before
  // it did, and that is usually worth keeping — so the failure is only fatal
  // when there is nothing else to show.
  if (failure !== undefined && answer === '') return { ok: false, error: failure };
  if (answer === '' && action === undefined) {
    return { ok: false, error: 'The help assistant sent nothing back.' };
  }
  return { ok: true, value: { answer, ...(action !== undefined && { action }) } };
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
