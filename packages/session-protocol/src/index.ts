/**
 * The wire format for a collaborative Isaac session.
 *
 * This package is the *envelope* and nothing else. The relay routes messages
 * between the members of a room; it does not know what a surface is, does not
 * parse a `.zmx`, and never resolves a glass. All of that stays in the browser,
 * for the same reason `optical-core` knows nothing about React — and the
 * practical consequence is that the server's dependencies are a WebSocket
 * library and this file.
 *
 * So every payload here is `unknown`. The client gives it meaning; the server
 * carries it.
 */

/**
 * Bumped when a change would make two builds misunderstand each other. A client
 * announces its version on `join` and a server that cannot speak it says so —
 * which is the whole point, since the failure this prevents is not a crash but
 * two people quietly looking at different designs.
 */
export const PROTOCOL_VERSION = 1;

export type MemberId = string;

export interface Member {
  readonly id: MemberId;
  readonly name: string;
}

/** A room id is chosen by whoever starts the meeting and appears in a URL. */
export const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{3,63}$/;

export const MAX_NAME_LENGTH = 40;

/**
 * A whole design travels as `.zmx` text, and the largest in the sample corpus
 * is well under 100 kB — but a session also carries the workspace and view
 * state, so the ceiling is generous. It exists to stop one member exhausting
 * the relay's memory, not to be reached.
 */
export const MAX_MESSAGE_BYTES = 4_000_000;

// ---------------------------------------------------------------- messages --

/**
 * Two kinds of traffic, and the distinction is the one Isaac already draws
 * between a *setting* and a *signal*.
 *
 * `state` is a setting: the design, the arrangement, what a member would want
 * if they joined late. It is whole, it is kept, and it is replayed to whoever
 * arrives next.
 *
 * `signal` is not: a camera orbit, a pointer, a hovered row. It is high-rate
 * and worth nothing a moment later, so it is never stored and a receiver is
 * free to drop one that arrives out of order.
 */
export type ClientMessage =
  | {
      readonly kind: 'join';
      readonly version: number;
      readonly room: string;
      readonly name: string;
    }
  | { readonly kind: 'state'; readonly payload: unknown }
  | { readonly kind: 'signal'; readonly seq: number; readonly payload: unknown };

export type ServerMessage =
  | {
      readonly kind: 'welcome';
      readonly version: number;
      readonly room: string;
      readonly you: MemberId;
      readonly members: readonly Member[];
    }
  /** `from` is null when the relay is replaying the room's last state to a joiner. */
  | { readonly kind: 'state'; readonly from: MemberId | null; readonly payload: unknown }
  | {
      readonly kind: 'signal';
      readonly from: MemberId;
      readonly seq: number;
      readonly payload: unknown;
    }
  | { readonly kind: 'joined'; readonly member: Member }
  | { readonly kind: 'left'; readonly id: MemberId }
  | { readonly kind: 'error'; readonly code: ErrorCode; readonly detail: string };

export const ERROR_CODES = [
  'BAD_MESSAGE',
  'UNSUPPORTED_VERSION',
  'BAD_ROOM',
  'BAD_NAME',
  'NOT_JOINED',
  'ALREADY_JOINED',
  'ROOM_FULL',
  'TOO_LARGE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// ----------------------------------------------------------------- parsing --

export type Parsed<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

const bad = (code: ErrorCode, detail: string): Parsed<never> => ({ ok: false, code, detail });

/**
 * A name is one line, collapsed — the same normalization `renameSystem` applies
 * to a lens name, and for a related reason: it is displayed in a list beside
 * other names, and a newline would break the row it sits in.
 */
export function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decode(text: string): Parsed<Record<string, unknown>> {
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
    return bad('TOO_LARGE', `message exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return bad('BAD_MESSAGE', 'not JSON');
  }
  if (!isRecord(value)) return bad('BAD_MESSAGE', 'not an object');
  return { ok: true, message: value };
}

/**
 * Rejects rather than repairs, which is the opposite of what `layout-storage`
 * does to a stored workspace — and deliberately. A stored arrangement someone
 * built is worth salvaging around one bad value; a malformed envelope is a
 * protocol violation from a build that does not agree with this one, and
 * guessing at what it meant is how two members end up believing different
 * things about the same design.
 */
export function parseClientMessage(text: string): Parsed<ClientMessage> {
  const decoded = decode(text);
  if (!decoded.ok) return decoded;
  const raw = decoded.message;

  switch (raw['kind']) {
    case 'join': {
      if (typeof raw['version'] !== 'number' || !Number.isInteger(raw['version'])) {
        return bad('BAD_MESSAGE', 'join needs an integer version');
      }
      if (raw['version'] !== PROTOCOL_VERSION) {
        return bad(
          'UNSUPPORTED_VERSION',
          `this relay speaks version ${PROTOCOL_VERSION}, not ${raw['version']}`,
        );
      }
      const room = raw['room'];
      if (typeof room !== 'string' || !ROOM_ID_PATTERN.test(room)) {
        return bad('BAD_ROOM', 'room must be 4-64 chars of a-z, 0-9 and -');
      }
      const name = typeof raw['name'] === 'string' ? normalizeName(raw['name']) : '';
      if (name.length === 0) return bad('BAD_NAME', 'name must not be empty');
      return { ok: true, message: { kind: 'join', version: PROTOCOL_VERSION, room, name } };
    }

    case 'state': {
      if (!('payload' in raw)) return bad('BAD_MESSAGE', 'state needs a payload');
      return { ok: true, message: { kind: 'state', payload: raw['payload'] } };
    }

    case 'signal': {
      const seq = raw['seq'];
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
        return bad('BAD_MESSAGE', 'signal needs a non-negative integer seq');
      }
      if (!('payload' in raw)) return bad('BAD_MESSAGE', 'signal needs a payload');
      return { ok: true, message: { kind: 'signal', seq, payload: raw['payload'] } };
    }

    default:
      return bad('BAD_MESSAGE', `unknown kind ${JSON.stringify(raw['kind'])}`);
  }
}

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * A signal arriving out of order is stale, and stale is worthless — the point
 * of the sequence number is that a receiver can say so without keeping a queue.
 * `undefined` means nothing has been seen from this sender yet.
 */
export function isStaleSignal(lastSeen: number | undefined, seq: number): boolean {
  return lastSeen !== undefined && seq <= lastSeen;
}
