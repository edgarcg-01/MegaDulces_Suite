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

/** SM.23 — Kepler cerró el turno y toca contar. Va dirigido a UNA cajera. */
export interface ReconArqueoDueItem {
  /** Código de cajera de Kepler = su username. Es la llave del aviso. */
  cajero_code: string;
  warehouse_code: string;
  caja: string;
  business_date: string;          // 'YYYY-MM-DD'
  folio: string;                  // turno de Kepler
  hora_cierre?: string | null;
  /** Minutos desde que Kepler cerró: distingue "recién" de "ya te pasaste". */
  cerrado_hace_min: number;
  /** true cuando ya venció el plazo y el supervisor lo está viendo. */
  vencido: boolean;
  /**
   * Qué te está pidiendo Kepler. `cierre` = el corte del cajón al terminar el
   * turno; `retiro` = la sangría del límite de caja, que se cuenta **con el turno
   * abierto** y es donde va el 63-81% del efectivo.
   */
  motivo?: 'cierre' | 'retiro';
}

export interface ReconNotifierPort {
  /** Notifica un "corte malo" (arqueo ciego divergente) de un tenant al supervisor. Best-effort. */
  notifyBadCut(tenantId: string, item: ReconBadCutItem): Promise<void>;
  /**
   * Le pide el arqueo a la cajera que le toca. Best-effort y **sin montos**: el
   * aviso dice que cuente, no cuánto debería haber (SM.10).
   */
  notifyArqueoDue?(tenantId: string, item: ReconArqueoDueItem): Promise<void>;
}
