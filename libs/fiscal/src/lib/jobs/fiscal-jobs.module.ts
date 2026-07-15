import { Module } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';
import { JobRunnerService } from './job-runner.service';

/**
 * FISCAL.3 (libs/fiscal) — Cola de trabajos en Postgres (sin BullMQ).
 * Exporta el encolador y el runner (con registro de handlers por `type`).
 */
@Module({
  providers: [JobQueueService, JobRunnerService],
  exports: [JobQueueService, JobRunnerService],
})
export class FiscalJobsModule {}
