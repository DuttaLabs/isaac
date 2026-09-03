/**
 * Proves a deployed relay actually carries a session: two clients meet in a
 * room and a design crosses between them, over the real URL, through nginx and
 * TLS. Run after a deploy — the unit tests say the code is right, this says the
 * machine is.
 *
 *   node infra/smoke.mjs wss://api.isaacoptics.com/
 */

import WebSocket from 'ws';

const url = process.argv[2] ?? 'wss://api.isaacoptics.com/';
const room = `smoke-${Math.random().toString(36).slice(2, 8)}`;
const design = { zmx: 'VERS 1\nNAME A DOUBLET\n', filename: 'doublet.zmx' };

const fail = (why) => {
  console.error(`FAIL  ${why}`);
  process.exit(1);
};
const timer = setTimeout(() => fail('timed out after 15s'), 15_000);

const open = (name) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const inbox = [];
    let wake;
    socket.on('message', (data) => {
      inbox.push(JSON.parse(data.toString()));
      wake?.();
    });
    socket.on('error', reject);
    socket.on('open', () => {
      socket.send(JSON.stringify({ kind: 'join', version: 1, room, name }));
      resolve({
        socket,
        send: (m) => socket.send(JSON.stringify(m)),
        next: async () => {
          if (inbox.length === 0) await new Promise((r) => (wake = r));
          wake = undefined;
          return inbox.shift();
        },
      });
    });
  });

const ada = await open('Ada');
const welcomeA = await ada.next();
if (welcomeA.kind !== 'welcome') fail(`expected welcome, got ${welcomeA.kind}`);
console.log(`  ok   joined ${room} as ${welcomeA.you}`);

const grace = await open('Grace');
const welcomeG = await grace.next();
if (welcomeG.kind !== 'welcome') fail(`expected welcome, got ${welcomeG.kind}`);
if (welcomeG.members.length !== 1) fail('the second member was not told about the first');
console.log(`  ok   second member sees ${welcomeG.members.map((m) => m.name).join(', ')}`);

const joined = await ada.next();
if (joined.kind !== 'joined') fail(`expected joined, got ${joined.kind}`);
console.log('  ok   first member was told about the second');

ada.send({ kind: 'state', payload: design });
const state = await grace.next();
if (state.kind !== 'state') fail(`expected state, got ${state.kind}`);
if (JSON.stringify(state.payload) !== JSON.stringify(design)) fail('the design was altered in transit');
console.log('  ok   a design crossed unaltered');

grace.send({ kind: 'signal', seq: 1, payload: { camera: [1, 2, 3] } });
const signal = await ada.next();
if (signal.kind !== 'signal' || signal.seq !== 1) fail('a signal did not arrive');
console.log('  ok   a signal crossed');

ada.socket.close();
const left = await grace.next();
if (left.kind !== 'left') fail(`expected left, got ${left.kind}`);
console.log('  ok   a departure was announced');

grace.socket.close();
clearTimeout(timer);
console.log(`\nPASS  ${url}`);
process.exit(0);
