/**
 * The Isaac session relay, as something that can be started rather than a
 * program that starts itself — so a test can run it on a port the operating
 * system picks and shut it down again, which is the only honest way to test a
 * socket.
 *
 * It binds to loopback and lives behind nginx, which terminates TLS and
 * performs the WebSocket upgrade. Nothing here speaks HTTPS, and the only port
 * facing the internet is nginx's.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { parseClientMessage, type ErrorCode, type Member } from '@isaac/session-protocol';
import { WebSocketServer, type WebSocket } from 'ws';

import { Rooms, send, type Sink } from './rooms.ts';

/** A connection that has not said `join` is holding a slot for nothing. */
export const JOIN_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 30_000;

export interface Relay {
  readonly httpServer: Server;
  /** Members and rooms, for the health endpoint and for tests. */
  readonly counts: () => { rooms: number; members: number };
  close(): Promise<void>;
}

type Log = (event: string, detail?: Record<string, unknown>) => void;

/**
 * One line of JSON per event: journald keeps it and `journalctl -o cat | jq`
 * reads it. Anything more structured would need somewhere to put it.
 */
const defaultLog: Log = (event, detail = {}) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
};

interface Session {
  room?: string;
  member?: Member;
  alive: boolean;
}

export function createRelay(log: Log = defaultLog): Relay {
  const rooms = new Rooms();
  const started = Date.now();

  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          uptimeSeconds: Math.round((Date.now() - started) / 1000),
          rooms: rooms.roomCount,
          members: rooms.memberCount,
        }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found\n');
  });

  const wss = new WebSocketServer({ server: httpServer });
  const sessions = new WeakMap<WebSocket, Session>();

  const sinkFor = (socket: WebSocket): Sink => ({
    send: (text) => {
      if (socket.readyState === socket.OPEN) socket.send(text);
    },
    close: (code, detail) => refuse(socket, code, detail),
  });

  /**
   * Say why before hanging up. A socket that simply closes leaves the far side
   * guessing between "wrong version", "bad room" and "the network went away".
   */
  const refuse = (socket: WebSocket, code: ErrorCode, detail: string): void => {
    if (socket.readyState === socket.OPEN) {
      send(sinkFor(socket), { kind: 'error', code, detail });
    }
    socket.close(1008, code);
  };

  wss.on('connection', (socket: WebSocket) => {
    const session: Session = { alive: true };
    sessions.set(socket, session);

    const joinTimer = setTimeout(() => {
      if (session.member === undefined) refuse(socket, 'NOT_JOINED', 'no join within 10s');
    }, JOIN_TIMEOUT_MS);

    socket.on('pong', () => {
      session.alive = true;
    });

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        refuse(socket, 'BAD_MESSAGE', 'this protocol is text');
        return;
      }
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        refuse(socket, parsed.code, parsed.detail);
        return;
      }
      const message = parsed.message;

      if (message.kind === 'join') {
        if (session.member !== undefined) {
          refuse(socket, 'ALREADY_JOINED', 'this connection is already in a room');
          return;
        }
        const result = rooms.join(message.room, message.name, sinkFor(socket));
        if (!result.ok) {
          refuse(socket, result.code, result.detail);
          return;
        }
        clearTimeout(joinTimer);
        session.room = message.room;
        session.member = result.member;
        log('join', { room: message.room, member: result.member.id, name: result.member.name });
        return;
      }

      if (session.member === undefined || session.room === undefined) {
        refuse(socket, 'NOT_JOINED', 'join a room first');
        return;
      }

      if (message.kind === 'state') {
        rooms.relayState(session.room, session.member.id, message.payload);
      } else {
        rooms.relaySignal(session.room, session.member.id, message.seq, message.payload);
      }
    });

    socket.on('close', () => {
      clearTimeout(joinTimer);
      if (session.room !== undefined && session.member !== undefined) {
        rooms.leave(session.room, session.member.id);
        log('leave', { room: session.room, member: session.member.id });
      }
    });

    socket.on('error', (error: Error) => log('socket-error', { message: error.message }));
  });

  /**
   * A dropped connection is not always a closed one — a laptop that sleeps or a
   * network that vanishes leaves a socket that looks open forever, and with it
   * a member who never leaves the room.
   */
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const session = sessions.get(socket);
      if (session === undefined) continue;
      if (!session.alive) {
        socket.terminate();
        continue;
      }
      session.alive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    httpServer,
    counts: () => ({ rooms: rooms.roomCount, members: rooms.memberCount }),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const socket of wss.clients) socket.close(1001, 'server going away');
        httpServer.close(() => resolve());
      }),
  };
}
