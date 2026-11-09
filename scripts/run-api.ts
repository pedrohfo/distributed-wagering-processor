import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { HttpApiModule } from '../src/http/http-api.module';

async function main(): Promise<void> {
  const app = await NestFactory.create(HttpApiModule);
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  await app.listen(port, '0.0.0.0');
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info',
    component: 'http-api', event: 'listening', port }));
}
void main().catch((error: unknown) => {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error',
    component: 'http-api', event: 'startup_failed',
    errorType: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
});
