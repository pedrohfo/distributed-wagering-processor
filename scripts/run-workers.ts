import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { BackgroundWorkersModule } from '../src/workers/background-workers.module';

async function main(): Promise<void> {
  if (process.env.WORKERS_ENABLED !== '1') {
    throw new Error('Set WORKERS_ENABLED=1 to start the background worker process');
  }
  const app = await NestFactory.createApplicationContext(BackgroundWorkersModule);
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  // No HTTP server: the pollers keep the process alive until shutdown.
}

void main().catch((error: unknown) => {
  const type = error instanceof Error ? error.name : 'UnknownError';
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', component: 'worker-bootstrap', event: 'startup_failed', errorType: type }));
  process.exitCode = 1;
});
