// @megadulces/reconciliation — barrel público.
// Supervisor de Movimientos (ADR-029): motor de cuadre caja/inventario/cruce,
// bandeja de descuadres con HITL y aprendizaje L2. Depende solo de platform-core;
// lee analytics.* (feeds Kepler) y escribe reconciliation.*.
export * from './lib/reconciliation.module';
export * from './lib/movement-reconcile.service';
export * from './lib/reconciliation-findings.service';
