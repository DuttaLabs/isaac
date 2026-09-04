/**
 * What the help assistant has cost, from the relay's own journal.
 *
 *   npm run help:usage            # today
 *   npm run help:usage -- -7d     # the last week
 *
 * The Console's billing figure is authoritative and its analytics panels lag
 * behind it by a day, so this exists to answer "what has this cost me?" without
 * waiting for a dashboard. It reads the same per-request accounting the API
 * returned, which is a stronger source than any rollup: every line is what one
 * question was actually billed at.
 */

import { execFileSync } from 'node:child_process';

const HOST = process.env.ISAAC_HOST ?? 'subrata@172.234.157.52';
const SINCE = process.argv[2] ?? 'today';

/**
 * Dollars per million tokens. Cache writes cost 1.25x the input rate and reads
 * 0.1x, which is the whole reason the manual is worth caching — and the whole
 * reason a question after a five-minute gap costs several times one asked in a
 * burst, since the gap makes it a write instead of a read.
 */
const PRICES = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

const costOf = (row) => {
  const price = PRICES[row.model];
  if (price === undefined) return undefined; // an unpriced model, said rather than guessed
  return (
    (row.in * price.in +
      (row.written ?? 0) * price.in * CACHE_WRITE +
      (row.cached ?? 0) * price.in * CACHE_READ +
      row.out * price.out) /
    1_000_000
  );
};

let journal;
try {
  journal = execFileSync(
    'ssh',
    [HOST, `sudo journalctl -u isaac-session --no-pager -o cat --since '${SINCE}'`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
} catch {
  console.error(`Could not read the journal on ${HOST}.`);
  process.exit(1);
}

const rows = journal
  .split('\n')
  .filter((line) => line.includes('"event":"help"'))
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter((row) => row !== undefined);

if (rows.length === 0) {
  console.log(`No help questions since ${SINCE}.`);
  process.exit(0);
}

const pad = (value, width) => String(value).padStart(width);
console.log('');
console.log('  when                 in   written    cached      out       ms      cost');
console.log('  ' + '-'.repeat(72));

let totals = { in: 0, written: 0, cached: 0, out: 0, cost: 0 };
let unpriced = 0;
for (const row of rows) {
  const cost = costOf(row);
  if (cost === undefined) unpriced += 1;
  totals.in += row.in;
  totals.written += row.written ?? 0;
  totals.cached += row.cached ?? 0;
  totals.out += row.out;
  totals.cost += cost ?? 0;
  console.log(
    '  ' +
      row.at.slice(0, 19).replace('T', ' ') +
      pad(row.in, 7) +
      pad(row.written ?? 0, 10) +
      pad(row.cached ?? 0, 10) +
      pad(row.out, 9) +
      pad(row.ms, 9) +
      pad(cost === undefined ? '?' : '$' + cost.toFixed(4), 10),
  );
}

console.log('  ' + '-'.repeat(72));
console.log(
  '  ' +
    `${rows.length} question${rows.length === 1 ? '' : 's'}`.padEnd(19) +
    pad(totals.in, 7) +
    pad(totals.written, 10) +
    pad(totals.cached, 10) +
    pad(totals.out, 9) +
    pad('', 9) +
    pad('$' + totals.cost.toFixed(4), 10),
);

const sent = totals.in + totals.written + totals.cached;
console.log('');
console.log(`  ${sent.toLocaleString()} tokens sent, ${totals.out.toLocaleString()} back`);
if (sent > 0) {
  const share = Math.round((totals.cached / sent) * 100);
  console.log(`  ${totals.cached.toLocaleString()} served from cache (${share}%)`);
}
// The one number that explains a surprising bill: a cache write means the
// five-minute entry had expired, so that question paid full price for the
// manual and then some.
const writes = rows.filter((row) => (row.written ?? 0) > 0).length;
if (writes > 0) {
  console.log(
    `  ${writes} question${writes === 1 ? '' : 's'} rewrote the cache — asked after a gap of more than five minutes`,
  );
}
if (unpriced > 0) {
  console.log(`  ${unpriced} answered by a model with no price here; cost excludes them`);
}
console.log('');
