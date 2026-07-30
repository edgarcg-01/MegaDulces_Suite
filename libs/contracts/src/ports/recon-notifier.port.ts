// SM.9 — Port de notificación del Supervisor de Movimientos.
//
// Cuando una cajera captura un arqueo ciego divergente en /tienda/arqueo, el motor
// levanta el descuadre al instante (autolineado) y necesita empujar una alerta WS al
// supervisor en /almacen/cuadre. El canal WS (AlertsGateway) vive en libs/commercial;
// reconciliation NO cruza esa frontera → inyecta este token + interface (@Optional) y
// el binding al impl real se hace en el composition root.
//
// Separado de FINANCE_NOTIFIER_PORT a propósito: aquel rutea a /finanzas/hallazgos con
// branding Maat; éste rutea a /almacen/cuadre. Best-effort: sin binding, no notifica.

export const RECON_NOTIFIER_PORT = 'RECON_NOTIFIER_PORT';

export interface ReconBadCutItem {
  warehouse_code: string;
  caja: string;
  business_date: string;          // 'YYYY-MM-DD'
  cajero?: string | null;
  diff_real: number;              // + faltante / − sobrante (esperado − contado ciego)
  kepler_enmascaro: boolean;      // Kepler dio el corte por cuadrado pero el ciego destapa
  captured_by?: string | null;
  incidencia_tipo?: string | null;
}

export interface ReconNotifierPort {
  /** Notifica un "corte malo" (arqueo ciego divergente) de un tenant al supervisor. Best-effort. */
  notifyBadCut(tenantId: string, item: ReconBadCutItem): Promise<void>;
}
