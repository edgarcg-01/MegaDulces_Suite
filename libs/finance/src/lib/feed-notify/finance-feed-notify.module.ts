import { Module } from '@nestjs/common';
import { FinanceFeedScannerService } from './finance-feed-scanner.service';
import { FinanceFeedNotifyController } from './finance-feed-notify.controller';

/**
 * CB (WS) — Aviso de feed nuevo (Kepler/ContPAQi) a los usuarios de Finanzas.
 * Scanner @Cron 30 min + disparadores manuales. Depende solo de globales
 * (KNEX_NEW_DB, TenantContextService, ScheduleModule root) + el puerto
 * FINANCE_NOTIFIER_PORT (@Optional, ligado en el composition root).
 */
@Module({
  controllers: [FinanceFeedNotifyController],
  providers: [FinanceFeedScannerService],
  exports: [FinanceFeedScannerService],
})
export class FinanceFeedNotifyModule {}
