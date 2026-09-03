/**
 * Isaac's end of a collaborative session.
 *
 * One connection for the whole app, held in `App` — not in a panel, which can
 * be opened twice and would then open two connections to the same room. A
 * panel is a *view* of this, the same way the Source panel is a view of the
 * system.
 */

import {
  PROTOCOL_VERSION,
  encode,
  isStaleSignal,
  normalizeName,
  ROOM_ID_PATTERN,
  type Member,
  type MemberId,
  type ServerMessage,
} from '@isaac/session-protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { CameraState } from './panel-settings.ts';

/** Overridable per deployment; the hostname is never written into the source. */
const SERVER_URL: string =
  (import.meta.env as Record<string, string | undefined>)['VITE_SESSION_URL'] ??
  'wss://api.isaacoptics.com/';

export type SessionStatus = 'offline' | 'connecting' | 'joined' | 'failed';

/**
 * What a whole session state carries. The design travels as `.zmx` text
 * because that serializer already exists and is verified across the entire
 * sample corpus — `OpticalSystem` is class instances, so `structuredClone`
 * would deliver its numbers without their prototypes and the far side would be
 * rebuilding the model from bare data.
 */
export interface SessionState {
  readonly design: string;
  readonly fileName?: string;
  /**
   * The rest of what is on screen. Optional so an older build's state still
   * carries a design, which is the half that matters most.
   *
   * Left as `unknown` here on purpose: this module knows about sessions, not
   * about workspaces, and `App` validates every piece of it with the same
   * readers that guard the stored layout. Trusting a tree because it arrived
   * over a socket would be worse than trusting one from `localStorage`.
   */
  readonly screen?: SharedScreen;
}

/**
 * Everything that makes two people's screens the same screen, beyond the design.
 *
 * A meeting is a shared *screen*, not a shared design — nobody should be
 * wondering why they cannot see the X–Z profile everyone else is discussing —
 * so the arrangement travels with the lens.
 */
export interface SharedScreen {
  readonly main?: unknown;
  readonly secondary?: unknown;
  readonly fields?: unknown;
  readonly elementStyles?: unknown;
  readonly selected?: unknown;
}

export function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['design'] !== 'string') return false;
  const name = record['fileName'];
  if (name !== undefined && typeof name !== 'string') return false;
  const screen = record['screen'];
  return screen === undefined || (typeof screen === 'object' && screen !== null);
}

/**
 * Where somebody is standing in the 3-D view.
 *
 * A *signal*, not a setting: it is sent many times a second while a drag is in
 * progress, never stored by the relay, and never replayed to a latecomer — a
 * camera position from a minute ago says nothing about where anyone is looking
 * now. `CameraState` is reused rather than redefined so the pose that travels
 * is the same pose a pane saves.
 */
export interface CameraSignal {
  readonly kind: 'camera';
  readonly camera: CameraState;
}

export function isCameraSignal(value: unknown): value is CameraSignal {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['kind'] !== 'camera') return false;
  const camera = record['camera'] as Record<string, unknown> | undefined;
  if (typeof camera !== 'object' || camera === null) return false;
  const triple = (v: unknown): boolean =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  return (
    triple(camera['position']) && triple(camera['target']) && typeof camera['zoom'] === 'number'
  );
}

/**
 * Two poses are the same picture. Used to stop a camera that was just applied
 * from being sent straight back out — the same trick as `lastSynced` for the
 * design, and needed for the same reason: `OrbitControls` raises `change` for
 * a programmatic update exactly as it does for a drag.
 */
export function sameCamera(a: CameraState | undefined, b: CameraState | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const near = (x: number, y: number): boolean => Math.abs(x - y) < 1e-6;
  return (
    a.zoom === b.zoom &&
    a.position.every((v, i) => near(v, b.position[i] ?? NaN)) &&
    a.target.every((v, i) => near(v, b.target[i] ?? NaN))
  );
}

export interface SessionHandlers {
  /**
   * The room has admitted us, and `members` is who was already here. Empty
   * means we are first — which is how the caller knows to *seed* the room with
   * its design rather than wait for someone else's, and what stops a joiner
   * broadcasting their own doublet over a meeting already in progress.
   */
  onWelcome?(members: readonly Member[], driving: boolean): void;
  onState?(payload: unknown, from: MemberId | null): void;
  onSignal?(payload: unknown, from: MemberId): void;
}

export interface Session {
  readonly status: SessionStatus;
  readonly room?: string;
  readonly you?: MemberId;
  readonly members: readonly Member[];
  /** Whose screen the meeting is looking at. */
  readonly driver?: MemberId;
  /** Whether that is us — the only state in which anything is published. */
  readonly driving: boolean;
  /** Why the last attempt failed, in the relay's own words. */
  readonly problem?: string;
  readonly serverUrl: string;
  join(room: string, name: string): void;
  leave(): void;
  /** Take the wheel. The relay decides, so this asks rather than asserts. */
  take(): void;
  sendState(state: SessionState): void;
  sendSignal(payload: unknown): void;
}

export function isRoomId(room: string): boolean {
  return ROOM_ID_PATTERN.test(room);
}

/** A room nobody has to invent: short, sayable over a call, and unambiguous. */
export function suggestRoomId(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l/o/0/1
  let id = '';
  for (let i = 0; i < 8; i += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${id.slice(0, 4)}-${id.slice(4)}`;
}

export function useSession(handlers: SessionHandlers): Session {
  const [status, setStatus] = useState<SessionStatus>('offline');
  const [room, setRoom] = useState<string | undefined>(undefined);
  const [you, setYou] = useState<MemberId | undefined>(undefined);
  const [members, setMembers] = useState<readonly Member[]>([]);
  const [driver, setDriver] = useState<MemberId | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const socket = useRef<WebSocket | undefined>(undefined);
  const seq = useRef(0);
  /** The last signal seen from each member, so a stale one can be dropped. */
  const lastSeen = useRef(new Map<MemberId, number>());

  /**
   * Handlers through a ref rather than a dependency: they close over the
   * design and are rebuilt every render, and depending on them would tear the
   * connection down and rebuild it on each keystroke.
   */
  const latest = useRef(handlers);
  latest.current = handlers;

  const leave = useCallback(() => {
    socket.current?.close(1000, 'left');
    socket.current = undefined;
    setStatus('offline');
    setRoom(undefined);
    setYou(undefined);
    setMembers([]);
    setDriver(undefined);
    lastSeen.current.clear();
  }, []);

  const join = useCallback(
    (wanted: string, rawName: string) => {
      const name = normalizeName(rawName);
      if (!isRoomId(wanted)) {
        setStatus('failed');
        setProblem('A room name is 4–64 characters of a–z, 0–9 and -');
        return;
      }
      if (name.length === 0) {
        setStatus('failed');
        setProblem('Put your name in, so the others know who joined');
        return;
      }

      socket.current?.close(1000, 'rejoining');
      setProblem(undefined);
      setStatus('connecting');

      const ws = new WebSocket(SERVER_URL);
      socket.current = ws;

      ws.addEventListener('open', () => {
        ws.send(encode({ kind: 'join', version: PROTOCOL_VERSION, room: wanted, name }));
      });

      ws.addEventListener('message', (event: MessageEvent<string>) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        switch (message.kind) {
          case 'welcome':
            setStatus('joined');
            setRoom(message.room);
            setYou(message.you);
            setMembers(message.members);
            setDriver(message.driver ?? undefined);
            latest.current.onWelcome?.(message.members, message.driver === message.you);
            return;
          case 'driver':
            setDriver(message.id ?? undefined);
            return;
          case 'joined':
            setMembers((present) => [...present, message.member]);
            return;
          case 'left':
            setMembers((present) => present.filter((m) => m.id !== message.id));
            lastSeen.current.delete(message.id);
            return;
          case 'state':
            latest.current.onState?.(message.payload, message.from);
            return;
          case 'signal': {
            // Out of order means superseded. The point of the sequence number
            // is that a receiver can say so without keeping a queue.
            if (isStaleSignal(lastSeen.current.get(message.from), message.seq)) return;
            lastSeen.current.set(message.from, message.seq);
            latest.current.onSignal?.(message.payload, message.from);
            return;
          }
          case 'error':
            setProblem(`${message.code}: ${message.detail}`);
            setStatus('failed');
            return;
        }
      });

      ws.addEventListener('close', () => {
        if (socket.current !== ws) return; // superseded by a newer attempt
        socket.current = undefined;
        setRoom(undefined);
        setYou(undefined);
        setMembers([]);
        setDriver(undefined);
        // A relay that refused us has already said why; do not overwrite it
        // with the close that followed.
        setStatus((was) => (was === 'failed' ? 'failed' : 'offline'));
      });

      ws.addEventListener('error', () => {
        setProblem(`Could not reach ${SERVER_URL}`);
        setStatus('failed');
      });
    },
    [],
  );

  const take = useCallback(() => {
    const ws = socket.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(encode({ kind: 'take' }));
  }, []);

  const sendState = useCallback((state: SessionState) => {
    const ws = socket.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(encode({ kind: 'state', payload: state }));
  }, []);

  const sendSignal = useCallback((payload: unknown) => {
    const ws = socket.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    seq.current += 1;
    ws.send(encode({ kind: 'signal', seq: seq.current, payload }));
  }, []);

  // Leaving the page should close the room cleanly rather than waiting for the
  // relay's heartbeat to notice a socket that will never answer again.
  useEffect(() => () => socket.current?.close(1000, 'unmounted'), []);

  return {
    status,
    room,
    you,
    members,
    driver,
    driving: you !== undefined && driver === you,
    problem,
    serverUrl: SERVER_URL,
    join,
    leave,
    take,
    sendState,
    sendSignal,
  };
}
