/**
 * Rooms, and what a relay remembers about them.
 *
 * Kept apart from the WebSocket plumbing so it can be tested without a socket:
 * a member here is anything that can be sent a string, which in production is a
 * connection and in a test is an array.
 */

import {
  PROTOCOL_VERSION,
  encode,
  type ErrorCode,
  type Member,
  type MemberId,
  type ServerMessage,
} from '@isaac/session-protocol';

export interface Sink {
  send(text: string): void;
  close(code: ErrorCode, detail: string): void;
}

interface Occupant {
  readonly member: Member;
  readonly sink: Sink;
}

interface Room {
  readonly occupants: Map<MemberId, Occupant>;
  /**
   * The last whole state anyone sent, replayed to whoever joins next. Held as
   * the *encoded* payload rather than a parsed one — the relay has no business
   * looking inside, and keeping it as received means it cannot be altered on
   * the way through.
   */
  lastState: unknown;
}

export const MAX_MEMBERS_PER_ROOM = 16;
export const MAX_ROOMS = 200;

export class Rooms {
  readonly #rooms = new Map<string, Room>();
  #nextId = 1;

  get roomCount(): number {
    return this.#rooms.size;
  }

  get memberCount(): number {
    let total = 0;
    for (const room of this.#rooms.values()) total += room.occupants.size;
    return total;
  }

  /**
   * Admits a member, tells them who is already there, replays the room's state,
   * and announces them to everyone else — in that order, because a joiner who
   * hears about themselves before they have been welcomed has nothing to hang
   * the news on.
   */
  join(roomId: string, name: string, sink: Sink): { ok: true; member: Member } | { ok: false; code: ErrorCode; detail: string } {
    let room = this.#rooms.get(roomId);
    if (room === undefined) {
      if (this.#rooms.size >= MAX_ROOMS) {
        return { ok: false, code: 'ROOM_FULL', detail: 'this relay is at capacity' };
      }
      room = { occupants: new Map(), lastState: undefined };
      this.#rooms.set(roomId, room);
    }
    if (room.occupants.size >= MAX_MEMBERS_PER_ROOM) {
      return { ok: false, code: 'ROOM_FULL', detail: `a room holds ${MAX_MEMBERS_PER_ROOM}` };
    }

    const member: Member = { id: `m${this.#nextId++}`, name };
    const others = [...room.occupants.values()].map((o) => o.member);

    send(sink, {
      kind: 'welcome',
      version: PROTOCOL_VERSION,
      room: roomId,
      you: member.id,
      members: others,
    });

    if (room.lastState !== undefined) {
      send(sink, { kind: 'state', from: null, payload: room.lastState });
    }

    room.occupants.set(member.id, { member, sink });
    this.#broadcast(room, member.id, { kind: 'joined', member });

    return { ok: true, member };
  }

  leave(roomId: string, id: MemberId): void {
    const room = this.#rooms.get(roomId);
    if (room === undefined) return;
    if (!room.occupants.delete(id)) return;
    if (room.occupants.size === 0) {
      // Nothing is kept for an empty room. A session is the people in it, and
      // holding a design for a meeting that ended would make this relay a store.
      this.#rooms.delete(roomId);
      return;
    }
    this.#broadcast(room, id, { kind: 'left', id });
  }

  /** A whole state: remembered for joiners, then passed on. */
  relayState(roomId: string, from: MemberId, payload: unknown): void {
    const room = this.#rooms.get(roomId);
    if (room === undefined) return;
    room.lastState = payload;
    this.#broadcast(room, from, { kind: 'state', from, payload });
  }

  /** A signal: passed on and forgotten. */
  relaySignal(roomId: string, from: MemberId, seq: number, payload: unknown): void {
    const room = this.#rooms.get(roomId);
    if (room === undefined) return;
    this.#broadcast(room, from, { kind: 'signal', from, seq, payload });
  }

  #broadcast(room: Room, except: MemberId, message: ServerMessage): void {
    const text = encode(message);
    for (const [id, occupant] of room.occupants) {
      if (id === except) continue;
      occupant.sink.send(text);
    }
  }
}

export function send(sink: Sink, message: ServerMessage): void {
  sink.send(encode(message));
}
