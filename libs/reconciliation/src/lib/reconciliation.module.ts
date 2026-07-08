import { Module } from '@nestjs/common';
import { MovementReconcileService } from './movement-reconcile.service';
import { ReconciliationFindingsService } from './reconciliation-findings.service';
import { ReconciliationQueryService } from './reconciliation-query.service';
import { ReconciliationScannerService } from './reconciliation-scanner.service';
import { BlindCountService } from './blind-count.service';
import { ReconciliationActionsService } from './reconciliation-actions.service';
import { ReconciliationController } from './reconciliation.controller';

/**
 * Supervisor de Movimientos (ADR-029) — motor de cuadre + bandeja de descuadres.
 * SM.1 = Plano caja · SM.2 = Plano inventario (merma) · SM.5 = cron nocturno + alerta.
 */
@Module({
  controllers: [ReconciliationController],
  providers: [MovementReconcileService, ReconciliationFindingsService, ReconciliationQueryService, ReconciliationScannerService, BlindCountService, ReconciliationActionsService],
  exports: [MovementReconcileService, ReconciliationFindingsService],
})
export class ReconciliationModule {}
