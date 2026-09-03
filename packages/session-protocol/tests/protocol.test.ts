import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MESSAGE_BYTES,
  MAX_NAME_LENGTH,
  PROTOCOL_VERSION,
  encode,
  isStaleSignal,
  normalizeName,
  parseClientMessage,
  type ClientMessage,
} from '../src/index.ts';

const join = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ kind: 'join', version: PROTOCOL_VERSION, room: 'lens-lab', name: 'Ada', ...over });

test('a join round-trips', () => {
  const parsed = parseClientMessage(join());
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.message, {
    kind: 'join',
    version: PROTOCOL_VERSION,
    room: 'lens-lab',
    name: 'Ada',
  });
});

test('a payload is carried without being understood', () => {
  // The relay never parses this, so anything JSON can hold must survive.
  const payload = { design: 'VERS 1\nNAME x', nested: [1, { deep: true }] };
  const parsed = parseClientMessage(JSON.stringify({ kind: 'state', payload }));
  assert.ok(parsed.ok);
  assert.deepEqual((parsed.message as { payload: unknown }).payload, payload);
});

test('a version this build does not speak is refused, not guessed at', () => {
  const parsed = parseClientMessage(join({ version: PROTOCOL_VERSION + 1 }));
  assert.ok(!parsed.ok);
  assert.equal(parsed.code, 'UNSUPPORTED_VERSION');
});

test('room ids are constrained', () => {
  for (const room of ['ab', 'Lens-Lab', 'lens lab', '-leading', 'x'.repeat(65), '']) {
    const parsed = parseClientMessage(join({ room }));
    assert.ok(!parsed.ok, `expected ${JSON.stringify(room)} to be refused`);
    assert.equal(parsed.code, 'BAD_ROOM');
  }
  assert.ok(parseClientMessage(join({ room: 'a1-b2' })).ok);
});

test('a name is one collapsed line, and an empty one is refused', () => {
  assert.equal(normalizeName('  Ada   Lovelace \n'), 'Ada Lovelace');
  assert.equal(normalizeName('x'.repeat(200)).length, MAX_NAME_LENGTH);

  const parsed = parseClientMessage(join({ name: '   ' }));
  assert.ok(!parsed.ok);
  assert.equal(parsed.code, 'BAD_NAME');
});

test('malformed envelopes are rejected rather than repaired', () => {
  const cases: Array<[string, string]> = [
    ['not json', 'BAD_MESSAGE'],
    ['[1,2,3]', 'BAD_MESSAGE'],
    ['"a string"', 'BAD_MESSAGE'],
    ['{"kind":"gossip"}', 'BAD_MESSAGE'],
    ['{"kind":"state"}', 'BAD_MESSAGE'],
    ['{"kind":"signal","payload":1}', 'BAD_MESSAGE'],
    ['{"kind":"signal","seq":-1,"payload":1}', 'BAD_MESSAGE'],
    ['{"kind":"signal","seq":1.5,"payload":1}', 'BAD_MESSAGE'],
  ];
  for (const [text, code] of cases) {
    const parsed = parseClientMessage(text);
    assert.ok(!parsed.ok, `expected ${text} to be refused`);
    assert.equal(parsed.code, code, text);
  }
});

test('a null payload is a payload', () => {
  // `'payload' in raw` rather than a truthiness check: null is a value a client
  // may legitimately send, and reading it as absent would refuse a valid message.
  const parsed = parseClientMessage('{"kind":"state","payload":null}');
  assert.ok(parsed.ok);
});

test('an oversized message is refused before it is parsed', () => {
  const huge = JSON.stringify({ kind: 'state', payload: 'x'.repeat(MAX_MESSAGE_BYTES) });
  const parsed = parseClientMessage(huge);
  assert.ok(!parsed.ok);
  assert.equal(parsed.code, 'TOO_LARGE');
});

test('encode and parse are inverses', () => {
  const messages: ClientMessage[] = [
    { kind: 'join', version: PROTOCOL_VERSION, room: 'lens-lab', name: 'Ada' },
    { kind: 'state', payload: { a: 1 } },
    { kind: 'signal', seq: 7, payload: [1, 2, 3] },
  ];
  for (const message of messages) {
    const parsed = parseClientMessage(encode(message));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.message, message);
  }
});

test('a signal is stale only when it is not newer', () => {
  assert.equal(isStaleSignal(undefined, 0), false);
  assert.equal(isStaleSignal(5, 6), false);
  assert.equal(isStaleSignal(5, 5), true);
  assert.equal(isStaleSignal(5, 4), true);
});
