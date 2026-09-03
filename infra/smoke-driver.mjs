import WebSocket from '/Users/subratadutta/Documents/javascript/isaac/node_modules/ws/index.js';
const URL = 'wss://api.isaacoptics.com/';
const room = `drv-${Math.random().toString(36).slice(2, 8)}`;
const fail = (w) => { console.error('FAIL ' + w); process.exit(1); };

const open = (name) => new Promise((res) => {
  const ws = new WebSocket(URL); const inbox = []; let wake;
  ws.on('message', (d) => { inbox.push(JSON.parse(d.toString())); wake?.(); });
  ws.on('open', () => { ws.send(JSON.stringify({ kind: 'join', version: 1, room, name }));
    res({ ws, send: (m) => ws.send(JSON.stringify(m)),
      next: async () => { if (!inbox.length) await new Promise((r) => (wake = r)); wake = undefined; return inbox.shift(); },
      pending: () => inbox.length }); });
});

const ada = await open('Ada');
const w1 = await ada.next();
if (w1.driver !== w1.you) fail('the first in should drive');
console.log(`  ok   first in drives (${w1.you})`);

const grace = await open('Grace');
const w2 = await grace.next();
if (w2.driver === w2.you) fail('a joiner should not take the wheel');
console.log(`  ok   joiner is a passenger, told the driver is ${w2.driver}`);
await ada.next();  // 'joined'

// A passenger shouting is ignored.
grace.send({ kind: 'state', payload: { design: 'a passenger shouting' } });
await new Promise((r) => setTimeout(r, 400));
if (ada.pending() !== 0) fail('a passenger reached the room: ' + JSON.stringify(await ada.next()));
console.log('  ok   a passenger is not relayed');

// Taking the wheel is announced to both.
grace.send({ kind: 'take' });
const a = await ada.next(), g = await grace.next();
if (a.kind !== 'driver' || g.kind !== 'driver') fail('handover not announced to both');
if (a.id !== w2.you || g.id !== w2.you) fail('the two were told different things');
console.log('  ok   handover announced to everyone, identically');

grace.send({ kind: 'state', payload: { design: 'the new driver' } });
const relayed = await ada.next();
if (relayed.kind !== 'state') fail('the new driver was not relayed');
console.log('  ok   the new driver is relayed');

// And the old one has stopped being.
ada.send({ kind: 'state', payload: { design: 'no longer driving' } });
await new Promise((r) => setTimeout(r, 400));
if (grace.pending() !== 0) fail('the old driver is still being relayed');
console.log('  ok   the old driver has stopped being relayed');

// The wheel passes when the driver goes.
grace.ws.close();
const passed = await ada.next();
const after = passed.kind === 'left' ? await ada.next() : passed;
if (after.kind !== 'driver' || after.id !== w1.you) fail('the wheel did not pass back');
console.log('  ok   the wheel passes when the driver leaves');

console.log(`\nPASS  driver arbitration, live in room ${room}`);
process.exit(0);
