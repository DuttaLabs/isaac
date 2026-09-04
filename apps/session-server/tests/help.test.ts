/**
 * The help endpoint, everywhere it can be tested without spending money.
 *
 * Every case here is a *refusal* — a bad body, a missing key, a caller over
 * their limit, a preflight. That is not a gap in the tests: the refusals are
 * the whole of what stands between this endpoint and somebody else's bill, and
 * they are the half that runs before any API call is made. What Claude answers
 * is the part a test cannot pin anyway.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { DAILY_LIMIT, MAX_QUESTION_LENGTH, PER_CLIENT_LIMIT } from '../src/help.ts';
import { createRelay } from '../src/relay.ts';

const ORIGIN = 'https://isaacoptics.com';

async function serverWith(
  access: Parameters<typeof createRelay>[1] = {},
  help: Parameters<typeof createRelay>[2] = {},
) {
  const relay = createRelay(() => {}, access, help);
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = relay.httpServer.address() as AddressInfo;
  return { relay, url: `http://127.0.0.1:${port}` };
}

/** A question asked the way the browser asks it. */
function ask(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/help`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('says so plainly when no API key is configured', async () => {
  const { relay, url } = await serverWith();
  try {
    const response = await ask(url, { question: 'What is a conic constant?' });
    assert.equal(response.status, 503);
    const { error } = (await response.json()) as { error: string };
    // The message has to name the cause. "Something went wrong" would send
    // somebody looking at their network.
    assert.match(error, /API key/);
  } finally {
    await relay.close();
  }
});

test('a preflight is answered, and does not demand the token it cannot carry', async () => {
  const { relay, url } = await serverWith({ token: 'secret' }, { apiKey: 'sk-test' });
  try {
    const response = await fetch(`${url}/help`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-isaac-token',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(response.headers.get('access-control-allow-headers') ?? '', /x-isaac-token/);
  } finally {
    await relay.close();
  }
});

test('the allowed origin is echoed exactly, never as a wildcard', async () => {
  const { relay, url } = await serverWith({ origins: [ORIGIN] }, {});
  try {
    const response = await ask(url, { question: 'hello' });
    // A `*` here would hand back to every site the access the origin check
    // just spent its time restricting.
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  } finally {
    await relay.close();
  }
});

test('another origin is refused before anything is spent', async () => {
  const { relay, url } = await serverWith({ origins: [ORIGIN] }, { apiKey: 'sk-test' });
  try {
    const response = await ask(url, { question: 'hello' }, { origin: 'https://elsewhere.example' });
    assert.equal(response.status, 403);
  } finally {
    await relay.close();
  }
});

test('a wrong token is refused, and the right one gets past the door', async () => {
  const { relay, url } = await serverWith({ token: 'secret' }, {});
  try {
    assert.equal((await ask(url, { question: 'hi' }, { 'x-isaac-token': 'wrong' })).status, 401);
    // No key configured, so the far side of the door is a 503 — which is
    // exactly the point: the token check passed and the request went through.
    assert.equal((await ask(url, { question: 'hi' }, { 'x-isaac-token': 'secret' })).status, 503);
  } finally {
    await relay.close();
  }
});

test('a body that is not a question is rejected rather than repaired', async () => {
  const { relay, url } = await serverWith({}, { apiKey: 'sk-test' });
  try {
    for (const body of ['not json', {}, { question: '' }, { question: '   ' }, { question: 5 }]) {
      assert.equal((await ask(url, body)).status, 400, `accepted ${JSON.stringify(body)}`);
    }
    const long = { question: 'x'.repeat(MAX_QUESTION_LENGTH + 1) };
    assert.equal((await ask(url, long)).status, 400);
    const bigContext = { question: 'hi', context: 'x'.repeat(200_000) };
    assert.equal((await ask(url, bigContext)).status, 413);
  } finally {
    await relay.close();
  }
});

test('one caller is held to a window, and everybody to a day', async () => {
  // A daily limit below the per-caller limit, so the day is what runs out.
  const { relay, url } = await serverWith({}, { apiKey: 'sk-test', dailyLimit: 2 });
  try {
    // With a key present these reach the API and fail there — a 502 — which
    // still consumes an allowance, because a call that was made is a call that
    // was paid for.
    assert.notEqual((await ask(url, { question: 'one' })).status, 429);
    assert.notEqual((await ask(url, { question: 'two' })).status, 429);
    const third = await ask(url, { question: 'three' });
    assert.equal(third.status, 429);
    const { error } = (await third.json()) as { error: string };
    assert.match(error, /today/);
  } finally {
    await relay.close();
  }
});

test('the limits are ordered so the daily cap is the real one', () => {
  // A per-caller window looser than the day would make the day unreachable by
  // one person and the cap a fiction. This is arithmetic, not behavior, and it
  // is the kind that goes wrong when somebody tunes one number.
  assert.ok(PER_CLIENT_LIMIT < DAILY_LIMIT);
});

test('an unknown path is still a 404, with help routed ahead of it', async () => {
  const { relay, url } = await serverWith();
  try {
    assert.equal((await fetch(`${url}/nothing`, { headers: { origin: ORIGIN } })).status, 404);
    // Health is answered before the door, so a monitor needs no token.
    assert.equal((await fetch(`${url}/health`)).status, 200);
  } finally {
    await relay.close();
  }
});

test('streaming asks for server-sent events, and says so in the headers', async () => {
  const { relay, url } = await serverWith({}, { apiKey: 'sk-test' });
  try {
    const response = await ask(url, { question: 'hello', stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    // nginx buffers a proxied response by default, which would hold the whole
    // answer back until the end — the exact pause streaming exists to remove,
    // and it would look like a bug in the browser rather than in the proxy.
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    await response.text();
  } finally {
    await relay.close();
  }
});

test('a failure mid-stream arrives as an event, not as a dead connection', async () => {
  // The status line is long gone by the time the API refuses a bad key, so the
  // only way left to say what happened is an event the client is watching for.
  // Without this the browser sees a stream that simply stops, which is
  // indistinguishable from an answer that finished.
  const { relay, url } = await serverWith({}, { apiKey: 'sk-not-a-real-key' });
  try {
    const response = await ask(url, { question: 'hello', stream: true });
    assert.equal(response.status, 200);
    const body = await response.text();
    const events = body
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data:'))
      .map((chunk) => JSON.parse(chunk.slice(5).trim()) as { kind: string });
    assert.ok(events.some((event) => event.kind === 'error'), `no error event in ${body}`);
  } finally {
    await relay.close();
  }
});

test('history that is not a list of exchanges is refused', async () => {
  const { relay, url } = await serverWith({}, { apiKey: 'sk-test' });
  try {
    assert.equal((await ask(url, { question: 'hi', history: 'yesterday' })).status, 400);
    assert.equal((await ask(url, { question: 'hi', history: [{ question: 'a' }] })).status, 400);
  } finally {
    await relay.close();
  }
});
