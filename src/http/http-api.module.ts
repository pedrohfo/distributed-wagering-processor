import { Module } from '@nestjs/common';
import { HttpResourcesService } from './http-resources.service';
import { WalletsController } from './wallets.controller';
import { WageringController, ProviderTransactionsController } from './wagering.controller';
import { HealthController } from './health.controller';

/** Dedicated HTTP server; background workers run in a separate Nest process. */
@Module({
  providers: [HttpResourcesService],
  controllers: [WalletsController, WageringController, ProviderTransactionsController, HealthController],
})
export class HttpApiModule {}
