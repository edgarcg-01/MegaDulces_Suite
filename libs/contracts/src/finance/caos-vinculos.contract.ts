/**
 * `[CGA-A.57]`/`[CGA-A.58]` Vínculos CAOS ↔ Caja General: la forma del boundary REST.
 *
 * Sólo tipos (ADR-052): producer (`CaosController`) y consumer (`/finanzas/caos`) importan lo
 * mismo, así que un cambio de forma es error de compilación en los dos lados.
 */

/** Un movimiento de Caja General que explica —en parte o entero— un movimiento de CAOS. */
export interface CaosVinculoFila {
  /** `null` cuando el movimiento NACIÓ en la máquina: no hay vínculo que quitar. */
  link_id: string | null;
  cash_ledger_id: string;
  folio: string;
  tipo: string;
  fecha: string;
  monto: number;
  estado: string;
  monto_enlazado: number;
  vinculado_at: string;
  /** Cómo quedó explicado: por un vínculo, o porque el movimiento se registró desde CAOS. */
  via: 'vinculo' | 'nacio_en_la_maquina';
}

/** Lo que ve supervisión de UN movimiento de CAOS: cuánto está explicado y cuánto queda libre. */
export interface CaosVinculos {
  movimiento_id: string;
  external_id: number;
  total: number;
  vinculado: number;
  /** `total - vinculado`: lo que todavía se puede vincular o registrar. */
  libre: number;
  filas: CaosVinculoFila[];
}

/** Respuesta de alta de un vínculo (`[CGA-A.58]`, sólo superadmin). */
export interface CaosVinculoAlta {
  ok: true;
  link_id: string;
  folio: string;
  monto: number;
}

/** Respuesta de baja de un vínculo (`[CGA-A.58]`, sólo superadmin, con motivo). */
export interface CaosVinculoBaja {
  ok: true;
  link_id: string;
}
