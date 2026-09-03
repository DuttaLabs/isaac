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
  assert.equal(grace.kinds.at(-1), 'left');
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
