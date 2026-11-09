import { Module } from '@nestjs/common';
import { BackgroundWorkersService } from './background-workers.service';

/** Worker-only Nest application context (no HTTP listener). */
@Module({ providers: [BackgroundWorkersService] })
export class BackgroundWorkersModule {}
