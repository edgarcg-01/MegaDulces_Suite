import { Module } from '@nestjs/common';
import { MovementReconcileService } from './movement-reconcile.service';
import { ReconciliationFindingsService } from './reconciliation-findings.service';
import { ReconciliationController } from './reconciliation.controller';

/**
 * Supervisor de Movimientos (ADR-029) — motor de cuadre + bandeja de descuadres.
 * SM.1 = Plano caja. SM.2/SM.3 agregan inventario y cruces; SM.5 el cron + alertas.
 */
@Module({
  controllers: [ReconciliationController],
  providers: [MovementReconcileService, ReconciliationFindingsService],
  exports: [MovementReconcileService, ReconciliationFindingsService],
})
export class ReconciliationModule {}
