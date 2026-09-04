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

import { createHelpEndpoint, type HelpConfig } from './help.ts';
import { Rooms, send, type Sink } from './rooms.ts';

/** A connection that has not said `join` is holding a slot for nothing. */
export const JOIN_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 30_000;

/**
 * Who may connect. Both are optional, and absent means "anybody" — which is
 * right for development and for a relay that is meant to be public.
 */
export interface Access {
  /**
   * Exact origins a browser may connect from. A browser always sends `Origin`
   * and cannot forge it, so this genuinely stops a page on another site from
   * opening a socket here. It stops nothing that is not a browser: `curl` will
   * send whatever origin it likes, which is why the token exists as well.
   */
  readonly origins?: readonly string[];
  /**
   * A shared secret. It is baked into the app at build time, and is only a
   * secret because the app itself is behind a login — the two protections are
   * one protection, and removing either removes both.
   *
   * It is spelled two ways, and the difference is forced rather than chosen:
   * the socket carries it in the query string because the WebSocket API cannot
   * set headers, while `/help` takes it in `x-isaac-token`, because an ordinary
   * request *can* set one and a token in a URL lands in nginx's access log.
   */
  readonly token?: string;
}

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

export function createRelay(
  log: Log = defaultLog,
  access: Access = {},
  help: HelpConfig = {},
): Relay {
  const rooms = new Rooms();
  const started = Date.now();
  const answerHelp = createHelpEndpoint(help, log);

  /**
   * Whether an ordinary request may proceed, and which origin to echo back if
   * it may. The same policy the socket's `verifyClient` applies, asked of an
   * HTTP request instead — one door with one lock.
   *
   * The token is *not* demanded of an `OPTIONS`, because a browser's preflight
   * carries no custom headers by definition. Refusing it there would refuse
   * every real request that follows, without either end saying why.
   */
  const admitHttp = (
    request: IncomingMessage,
  ): { ok: true; origin?: string } | { ok: false; status: number; why: string } => {
    const origin = request.headers.origin;
    if (access.origins !== undefined && !access.origins.includes(origin ?? '')) {
      return { ok: false, status: 403, why: 'origin' };
    }
    if (access.token !== undefined && request.method !== 'OPTIONS') {
      if (request.headers['x-isaac-token'] !== access.token) {
        return { ok: false, status: 401, why: 'token' };
      }
    }
    return { ok: true, ...(origin !== undefined && { origin }) };
  };

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
    const admission = admitHttp(request);
    if (!admission.ok) {
      log('refused', { why: admission.why, path: (request.url ?? '/').split('?')[0] });
      response.writeHead(admission.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `${admission.why} not allowed` }));
      return;
    }

    void answerHelp(request, response, admission.origin).then((handled) => {
      if (handled) return;
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found\n');
    });
  });

  const wss = new WebSocketServer({
    server: httpServer,
    /**
     * Refused before the socket opens rather than after, so a rejected caller
     * gets an HTTP 401 it can read instead of a connection that closes for no
     * stated reason.
     */
    verifyClient: ({ origin, req }, done) => {
      if (access.origins !== undefined && !access.origins.includes(origin ?? '')) {
        log('refused', { why: 'origin', origin: origin ?? null });
        done(false, 403, 'origin not allowed');
        return;
      }
      if (access.token !== undefined) {
        const url = new URL(req.url ?? '/', 'http://placeholder');
        if (url.searchParams.get('t') !== access.token) {
          log('refused', { why: 'token' });
          done(false, 401, 'token required');
          return;
        }
      }
      done(true);
    },
  });
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

      switch (message.kind) {
        case 'state':
          rooms.relayState(session.room, session.member.id, message.payload);
          return;
        case 'signal':
          rooms.relaySignal(session.room, session.member.id, message.seq, message.payload);
          return;
        case 'take':
          rooms.take(session.room, session.member.id);
          log('take', { room: session.room, member: session.member.id });
          return;
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
