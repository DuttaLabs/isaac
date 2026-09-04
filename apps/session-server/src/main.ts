/**
 * Runs the relay. Everything interesting is in `relay.ts`; this file is the
 * part that reads the environment and answers to systemd.
 */

import { createRelay } from './relay.ts';

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = process.env['HOST'] ?? '127.0.0.1';

/**
 * Read from the environment, never from the source. Absent means open, which is
 * what a development machine wants and what a public relay will want later.
 */
const origins = process.env['ISAAC_ORIGINS']?.split(',').map((o) => o.trim()).filter(Boolean);
const relay = createRelay(
  undefined,
  {
    origins: origins?.length ? origins : undefined,
    token: process.env['ISAAC_TOKEN'] || undefined,
  },
  {
    /**
     * No key means no help assistant, and the endpoint says so rather than
     * failing obscurely. That is the right default: a development machine and
     * anyone else's checkout should not be able to spend money by accident.
     */
    apiKey: process.env['ANTHROPIC_API_KEY'] || undefined,
    /** Which model answers, changeable without a deploy. */
    model: process.env['ISAAC_HELP_MODEL'] || undefined,
    dailyLimit: Number(process.env['ISAAC_HELP_DAILY_LIMIT']) || undefined,
  },
);

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
