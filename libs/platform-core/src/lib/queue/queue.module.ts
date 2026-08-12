import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service';

/**
 * QueueModule — infra de cola de jobs (pg-boss). INFRA.3, ADR-043.
 *
 * Global e importado siempre; el `QueueService` se auto-gatea por
 * `ENABLE_WORKER_QUEUE` (inerte por default → app corre legacy). Ver
 * queue.service.ts para el diseño del worker-tier.
 */
@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
