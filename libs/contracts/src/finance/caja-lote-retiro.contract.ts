/**
 * `[CGA-A.60]` Un retiro de CAOS paga un lote de egresos de la cola: la forma del boundary REST.
 *
 * Sólo tipos (ADR-052): producer (`CashLedgerController`) y consumer (`/finanzas/caja-general`)
 * importan lo mismo, así que un cambio de forma es error de compilación en los dos lados.
 */

/** Un retiro de CAOS al que todavía le queda dinero libre: puede pagar un lote. */
export interface CaosRetiroLibre {
  device: string;
  external_id: number;
  occurred_at: string;
  ref: string | null;
  user_external: string | null;
  /** Lo que sacó la máquina. */
  total: number;
  /** Lo que todavía no explica ningún egreso. */
  libre: number;
}

export interface CaosRetirosLibres {
  rows: CaosRetiroLibre[];
  desde: string;
  limit: number;
}

/** Cómo quedó el retiro después de pagar el lote. */
export interface CaosRetiroDelLote {
  device: string;
  external_id: number;
  ref: string | null;
  /** Lo que tenía libre el retiro al empezar el lote. */
  libre_antes: number;
  /** Σ de lo que tomaron los egresos guardados. */
  tomado: number;
  /** Lo que el retiro todavía tiene libre: el corte lo espera en el cajón si nadie más lo toma. */
  libre_despues: number;
  /** Lo que el retiro NO alcanzó a pagar de los egresos guardados: salió del cajón. */
  del_cajon: number;
}
