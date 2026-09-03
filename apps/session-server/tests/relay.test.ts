import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { PROTOCOL_VERSION, encode, type ServerMessage } from '@isaac/session-protocol';
import WebSocket from 'ws';

import { createRelay } from '../src/relay.ts';

/** Start a relay on a port the OS picks, so tests never collide. */
async function relayOnLoopback() {
  const relay = createRelay(() => {});
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = relay.httpServer.address() as AddressInfo;
  return { relay, url: `ws://127.0.0.1:${port}`, port };
}

/** A client that queues what arrives, so a test can await the next message. */
function client(url: string) {
  const socket = new WebSocket(url);
  const queue: ServerMessage[] = [];
  let wake: (() => void) | undefined;

  socket.on('message', (data: Buffer) => {
    queue.push(JSON.parse(data.toString()) as ServerMessage);
    wake?.();
  });

  return {
    socket,
    open: () => new Promise<void>((resolve) => socket.once('open', resolve)),
    send: (message: unknown) => socket.send(typeof message === 'string' ? message : JSON.stringify(message)),
    next: async (): Promise<ServerMessage> => {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      return queue.shift()!;
    },
    closed: () => new Promise<number>((resolve) => socket.once('close', (code: number) => resolve(code))),
  };
}

const joinMessage = (room: string, name: string) =>
  encode({ kind: 'join', version: PROTOCOL_VERSION, room, name });

test('two clients meet through the relay', async () => {
  const { relay, url } = await relayOnLoopback();
  try {
    const ada = client(url);
    await ada.open();
    ada.send(joinMessage('lens-lab', 'Ada'));
    assert.equal((await ada.next()).kind, 'welcome');

    const grace = client(url);
    await grace.open();
    grace.send(joinMessage('lens-lab', 'Grace'));

    const welcome = await grace.next();
    assert.equal(welcome.kind, 'welcome');
    assert.equal(
      (welcome as Extract<ServerMessage, { kind: 'welcome' }>).driver,
      'm1',
      'the first in drives, and a joiner is told so',
    );
    assert.deepEqual(
      (welcome as Extract<ServerMessage, { kind: 'welcome' }>).members.map((m) => m.name),
      ['Ada'],
    );

    // Ada is told Grace arrived.
    const joined = await ada.next();
    assert.equal(joined.kind, 'joined');

    // A design crosses, byte for byte.
    const design = { zmx: 'VERS 1\nNAME A DOUBLET\nSURF 0\n', filename: 'doublet.zmx' };
    ada.send({ kind: 'state', payload: design });
    const state = await grace.next();
    assert.equal(state.kind, 'state');
    assert.deepEqual((state as Extract<ServerMessage, { kind: 'state' }>).payload, design);

    // A passenger is not relayed: one screen is the meeting's screen.
    grace.send({ kind: 'signal', seq: 1, payload: { camera: [3, 4, 5] } });

    // So Grace takes the wheel first, and both are told.
    grace.send({ kind: 'take' });
    const handoverA = await ada.next();
    assert.equal(handoverA.kind, 'driver');
    const handoverG = await grace.next();
    assert.equal(handoverG.kind, 'driver');
    assert.equal(
      (handoverG as Extract<ServerMessage, { kind: 'driver' }>).id,
      (welcome as Extract<ServerMessage, { kind: 'welcome' }>).you,
    );

    // And a camera orbit, which is a signal rather than a setting.
    grace.send({ kind: 'signal', seq: 2, payload: { camera: [3, 4, 5] } });
    const signal = await ada.next();
    assert.equal(signal.kind, 'signal', 'the shout before taking it was dropped, not queued');
    assert.equal((signal as Extract<ServerMessage, { kind: 'signal' }>).seq, 2);

    assert.deepEqual(relay.counts(), { rooms: 1, members: 2 });

    ada.socket.close();
    const left = await grace.next();
    assert.equal(left.kind, 'left');
  } finally {
    await relay.close();
  }
});

test('a version mismatch is refused with a reason, not a silent close', async () => {
  const { relay, url } = await relayOnLoopback();
  try {
    const stale = client(url);
    await stale.open();
    stale.send(encode({ kind: 'join', version: PROTOCOL_VERSION + 1, room: 'lens-lab', name: 'Old' } as never));

    const error = await stale.next();
    assert.equal(error.kind, 'error');
    assert.equal((error as Extract<ServerMessage, { kind: 'error' }>).code, 'UNSUPPORTED_VERSION');
    assert.equal(await stale.closed(), 1008);
  } finally {
    await relay.close();
  }
});

test('nothing may be relayed before joining', async () => {
  const { relay, url } = await relayOnLoopback();
  try {
    const impatient = client(url);
    await impatient.open();
    impatient.send({ kind: 'state', payload: { design: 'x' } });

    const error = await impatient.next();
    assert.equal((error as Extract<ServerMessage, { kind: 'error' }>).code, 'NOT_JOINED');
  } finally {
    await relay.close();
  }
});

test('health reports what the relay is holding', async () => {
  const { relay, url, port } = await relayOnLoopback();
  try {
    const ada = client(url);
    await ada.open();
    ada.send(joinMessage('lens-lab', 'Ada'));
    await ada.next();

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; rooms: number; members: number };
    assert.deepEqual({ ok: body.ok, rooms: body.rooms, members: body.members }, {
      ok: true,
      rooms: 1,
      members: 1,
    });
  } finally {
    await relay.close();
  }
});
