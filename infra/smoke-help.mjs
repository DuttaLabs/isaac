/**
 * Proves the deployed help endpoint really answers: a real question, over the
 * real URL, through nginx and TLS, and back with prose in it.
 *
 *   node infra/smoke-help.mjs https://api.isaacoptics.com/help
 *
 * This one costs money — a fraction of a penny — and that is the point. The
 * things it catches cannot be caught any other way: a key that was rotated, a
 * model name that no longer exists, an origin rule that refuses the app. All
 * three fail *only* on a real call, and all three would otherwise be discovered
 * by somebody typing a question into a box and getting nothing back.
 */

const url = process.argv[2] ?? 'https://api.isaacoptics.com/help';
const ORIGIN = process.env.ISAAC_ORIGIN ?? 'https://isaacoptics.com';
const TOKEN = process.env.ISAAC_TOKEN || undefined;

const fail = (why) => {
  console.error(`FAIL  ${why}`);
  process.exit(1);
};

// A question with a checkable answer: the manual says Isaac has no optimizer,
// so a reply that offers one is a reply that has stopped reading the manual.
const question = 'Does Isaac have an optimizer?';

const timer = setTimeout(() => fail('timed out after 60s'), 60_000);

try {
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(TOKEN !== undefined && { 'x-isaac-token': TOKEN }),
    },
    body: JSON.stringify({ question }),
  });

  const body = await response.json().catch(() => undefined);
  if (!response.ok) fail(`${response.status} — ${body?.error ?? 'no reason given'}`);
  if (typeof body?.answer !== 'string' || body.answer.trim() === '') fail('no answer in the body');

  const ms = Date.now() - started;
  const answer = body.answer.replace(/\s+/g, ' ').trim();

  // Not an assertion on the wording — a model may phrase a refusal a dozen
  // ways, and a smoke test that fails on phrasing is one nobody keeps. This
  // only says loudly when the answer looks like the failure mode that matters.
  const denies = /\b(no|not|cannot|can't|does not|doesn't|lacks|without)\b/i.test(answer);

  console.log(`OK    help answered in ${ms} ms`);
  console.log(`      Q: ${question}`);
  console.log(`      A: ${answer.slice(0, 220)}${answer.length > 220 ? '…' : ''}`);
  if (!denies) {
    console.log('WARN  that answer does not read like a denial — Isaac has no optimizer.');
  }
  clearTimeout(timer);
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
