/**
 * Process entrypoint.
 *
 * SUAS-specs ENVIRONMENT.md §5: startup validation runs before serving traffic and
 * fails closed. A configuration or schema-state failure exits non-zero with the
 * violated invariants and never degrades into a partially-started process.
 */

import { startApp } from './app.js';

async function main(): Promise<void> {
  const app = await startApp({ env: process.env });

  const shutdown = (signal: string): void => {
    app.server.log.info({ signal }, 'shutting down');
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
