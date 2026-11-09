import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HttpResourcesService } from './http-resources.service';

@Controller('health')
export class HealthController {
  constructor(private readonly resources: HttpResourcesService) {}

  @Get('live')
  live() { return { status: 'ok' }; }

  @Get('ready')
  async ready() {
    try {
      await this.resources.checkReady();
      return { status: 'ready', dependencies: { postgres: 'ok', sqs: 'ok' } };
    } catch (error) {
  console.error('[HEALTH READY FAILED]', error);

  throw new ServiceUnavailableException(
    'Not ready: PostgreSQL or SQS unavailable',
  );
}
  }
}
