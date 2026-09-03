/**
 * Runs the relay. Everything interesting is in `relay.ts`; this file is the
 * part that reads the environment and answers to systemd.
 */

import { createRelay } from './relay.ts';

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = process.env['HOST'] ?? '127.0.0.1';

const relay = createRelay();

relay.httpServer.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event: 'listening', host: HOST, port: PORT }));
});

const shutdown = (signal: string): void => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event: 'shutdown', signal }));
  // systemd sends SIGKILL eventually; do not wait forever on a stuck socket.
  const giveUp = setTimeout(() => process.exit(0), 5_000);
  giveUp.unref();
  void relay.close().then(() => process.exit(0));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
