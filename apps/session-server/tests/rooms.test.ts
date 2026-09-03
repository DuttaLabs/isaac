import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ServerMessage } from '@isaac/session-protocol';

import { MAX_MEMBERS_PER_ROOM, Rooms, type Sink } from '../src/rooms.ts';

/** A member that is an array: everything it was sent, in order. */
function recorder(): Sink & { readonly sent: ServerMessage[]; readonly kinds: string[] } {
  const sent: ServerMessage[] = [];
  return {
    sent,
    get kinds() {
      return sent.map((m) => m.kind);
    },
    send: (text) => void sent.push(JSON.parse(text) as ServerMessage),
    close: () => {},
  };
}

test('a joiner is welcomed before anyone hears about them', () => {
  const rooms = new Rooms();
  const ada = recorder();
  const grace = recorder();

  rooms.join('lab', 'Ada', ada);
  rooms.join('lab', 'Grace', grace);

  assert.deepEqual(ada.kinds, ['welcome', 'joined']);
  assert.deepEqual(grace.kinds, ['welcome']);

  const welcome = grace.sent[0] as Extract<ServerMessage, { kind: 'welcome' }>;
  assert.deepEqual(
    welcome.members.map((m) => m.name),
    ['Ada'],
    'the welcome lists who was already there',
  );
});

test('a latecomer is given the room state, marked as replayed', () => {
  const rooms = new Rooms();
  const ada = recorder();
  rooms.join('lab', 'Ada', ada);
  rooms.relayState('lab', 'm1', { design: 'a doublet' });

  const grace = recorder();
  rooms.join('lab', 'Grace', grace);

  assert.deepEqual(grace.kinds, ['welcome', 'state']);
  const state = grace.sent[1] as Extract<ServerMessage, { kind: 'state' }>;
  assert.equal(state.from, null, 'a replay is from the room, not from a member');
  assert.deepEqual(state.payload, { design: 'a doublet' });
});

test('a payload is carried unaltered — the relay never looks inside', () => {
  const rooms = new Rooms();
  const ada = recorder();
  const grace = recorder();
  rooms.join('lab', 'Ada', ada);
  rooms.join('lab', 'Grace', grace);

  const payload = { zmx: 'VERS\nNAME x', nested: [null, { deep: true }], n: 1.5 };
  rooms.relayState('lab', 'm1', payload);

  const relayed = grace.sent.at(-1) as Extract<ServerMessage, { kind: 'state' }>;
  assert.deepEqual(relayed.payload, payload);
});

test('a signal reaches everyone but the sender, and is not kept', () => {
  const rooms = new Rooms();
  const ada = recorder();
  const grace = recorder();
  rooms.join('lab', 'Ada', ada);
  rooms.join('lab', 'Grace', grace);

  rooms.relaySignal('lab', 'm1', 7, { camera: [1, 2, 3] });
  assert.equal(grace.kinds.at(-1), 'signal');
  assert.ok(!ada.kinds.includes('signal'), 'a sender is not sent its own signal');

  // Not replayed to a joiner: a camera position from a minute ago is noise.
  const hopper = recorder();
  rooms.join('lab', 'Hopper', hopper);
  assert.deepEqual(hopper.kinds, ['welcome']);
});

test('leaving is announced, and an empty room is forgotten', () => {
  const rooms = new Rooms();
  const ada = recorder();
  const grace = recorder();
  rooms.join('lab', 'Ada', ada);
  rooms.join('lab', 'Grace', grace);
  rooms.relayState('lab', 'm1', { design: 'a doublet' });

  rooms.leave('lab', 'm1');
  // Two things happened, in this order: somebody left, and because they had the
  // wheel it passed to the only person still here.
  assert.deepEqual(grace.kinds.slice(-2), ['left', 'driver']);
  assert.equal(rooms.driverOf('lab'), 'm2');
  assert.equal(rooms.roomCount, 1);

  rooms.leave('lab', 'm2');
  assert.equal(rooms.roomCount, 0, 'the last member out takes the room with them');

  // And the design goes with it — a relay is not a store.
  const later = recorder();
  rooms.join('lab', 'Ada', later);
  assert.deepEqual(later.kinds, ['welcome']);
});

test('rooms do not leak members into each other', () => {
  const rooms = new Rooms();
  const ada = recorder();
  const grace = recorder();
  rooms.join('one', 'Ada', ada);
  rooms.join('two', 'Grace', grace);

  rooms.relayState('one', 'm1', { design: 'x' });
  assert.deepEqual(grace.kinds, ['welcome']);
  assert.equal(rooms.roomCount, 2);
});

test('a full room is refused rather than quietly enlarged', () => {
  const rooms = new Rooms();
  for (let i = 0; i < MAX_MEMBERS_PER_ROOM; i += 1) {
    assert.ok(rooms.join('lab', `member ${i}`, recorder()).ok);
  }
  const refused = rooms.join('lab', 'one too many', recorder());
  assert.ok(!refused.ok);
  assert.equal(refused.code, 'ROOM_FULL');
  assert.equal(rooms.memberCount, MAX_MEMBERS_PER_ROOM);
});

test('relaying into a room nobody is in does nothing', () => {
  const rooms = new Rooms();
  rooms.relayState('ghost', 'm1', { design: 'x' });
  rooms.relaySignal('ghost', 'm1', 1, {});
  rooms.leave('ghost', 'm1');
  assert.equal(rooms.roomCount, 0);
});

test('the first in drives, and everyone is told the same thing', () => {
  const rooms = new Rooms();
  const ada = recorder();
  rooms.join('lens-lab', 'Ada', ada);
  const welcomeA = ada.sent[0] as Extract<ServerMessage, { kind: 'welcome' }>;
  assert.equal(welcomeA.driver, welcomeA.you, 'the first in takes the wheel');

  const grace = recorder();
  rooms.join('lens-lab', 'Grace', grace);
  const welcomeG = grace.sent[0] as Extract<ServerMessage, { kind: 'welcome' }>;
  assert.equal(welcomeG.driver, 'm1', 'a joiner is told who has it, and it is not them');
  assert.notEqual(welcomeG.you, welcomeG.driver);
});

test('only the driver is relayed — one screen is an invariant, not an agreement', () => {
  const rooms = new Rooms();
  const ada = recorder();
  const grace = recorder();
  rooms.join('lens-lab', 'Ada', ada);   // m1 drives
  rooms.join('lens-lab', 'Grace', grace);

  rooms.relayState('lens-lab', 'm2', { design: 'a passenger shouting' });
  rooms.relaySignal('lens-lab', 'm2', 1, { camera: 'likewise' });
  assert.deepEqual(ada.kinds, ['welcome', 'joined'], 'nothing from a passenger reaches the room');

  rooms.relayState('lens-lab', 'm1', { design: 'the driver' });
  assert.equal(grace.kinds.at(-1), 'state');
});

test('taking the wheel is announced to everyone, the taker included', () => {
  const rooms = new Rooms();
  const ada = recorder();
  const grace = recorder();
  rooms.join('lens-lab', 'Ada', ada);
  rooms.join('lens-lab', 'Grace', grace);

  rooms.take('lens-lab', 'm2');
  assert.equal(rooms.driverOf('lens-lab'), 'm2');
  for (const [who, seat] of [['ada', ada], ['grace', grace]] as const) {
    const last = seat.sent.at(-1) as Extract<ServerMessage, { kind: 'driver' }>;
    assert.equal(last.kind, 'driver', `${who} was told`);
    assert.equal(last.id, 'm2');
  }

  // And now the roles are exactly reversed.
  rooms.relayState('lens-lab', 'm1', { design: 'no longer the driver' });
  assert.equal(grace.kinds.at(-1), 'driver', 'the old driver has stopped being relayed');
  rooms.relayState('lens-lab', 'm2', { design: 'the new driver' });
  assert.equal(ada.kinds.at(-1), 'state');
});

test('taking it twice says nothing the second time', () => {
  const rooms = new Rooms();
  const ada = recorder();
  const grace = recorder();
  rooms.join('lens-lab', 'Ada', ada);
  rooms.join('lens-lab', 'Grace', grace);
  const before = grace.sent.length;
  rooms.take('lens-lab', 'm1');   // already driving
  assert.equal(grace.sent.length, before);
});

test('somebody who is not in the room cannot take it', () => {
  const rooms = new Rooms();
  const ada = recorder();
  rooms.join('lens-lab', 'Ada', ada);
  rooms.take('lens-lab', 'stranger');
  assert.equal(rooms.driverOf('lens-lab'), 'm1');
});

test('the wheel passes when the driver leaves, to whoever has been here longest', () => {
  const rooms = new Rooms();
  const ada = recorder();
  const grace = recorder();
  const hopper = recorder();
  rooms.join('lens-lab', 'Ada', ada);      // m1 drives
  rooms.join('lens-lab', 'Grace', grace);  // m2
  rooms.join('lens-lab', 'Hopper', hopper);// m3

  rooms.leave('lens-lab', 'm1');
  assert.equal(rooms.driverOf('lens-lab'), 'm2', 'not to nobody, and not to the newest');
  assert.equal(grace.kinds.at(-1), 'driver');
  assert.equal(hopper.kinds.at(-1), 'driver');

  // A meeting survives the organizer's laptop shutting.
  rooms.relayState('lens-lab', 'm2', { design: 'carrying on' });
  assert.equal(hopper.kinds.at(-1), 'state');
});

test('a passenger leaving does not disturb the wheel', () => {
  const rooms = new Rooms();
  const ada = recorder();
  const grace = recorder();
  rooms.join('lens-lab', 'Ada', ada);
  rooms.join('lens-lab', 'Grace', grace);
  const before = ada.sent.length;
  rooms.leave('lens-lab', 'm2');
  assert.equal(rooms.driverOf('lens-lab'), 'm1');
  assert.equal(ada.sent.length, before + 1, 'just the departure');
  assert.equal(ada.kinds.at(-1), 'left');
});
