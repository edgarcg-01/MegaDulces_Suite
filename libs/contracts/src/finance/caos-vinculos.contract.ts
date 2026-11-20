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

/**
 * `[LE.6.37]` Un cobro YA CAPTURADO que todavía no dice a qué depósito de CAOS fue su efectivo.
 * Lo ve quien captura, en Caja General, al abrir un depósito: «¿de qué cobros es?».
 */
export interface DepositoCobroCandidato {
  cash_ledger_id: string;
  folio: string;
  /** `YYYY-MM-DD`. */
  fecha: string;
  sucursal: string;
  ruta: string | null;
  glosa: string | null;
  monto: number;
  /** Lo que al cobro le falta por explicar con un depósito (`monto - ya vinculado`). */
  falta: number;
}

/** `[LE.6.37]` El depósito y los cobros que pueden explicarlo (fecha del cobro ≤ día del depósito). */
export interface DepositoCobros {
  deposito: { device: string; external_id: number; fecha: string; ref: string | null; total: number; libre: number };
  /** Ventana que se miró, para declararla: cobros de `desde` al día del depósito. */
  desde: string;
  rows: DepositoCobroCandidato[];
  /** `true` si la lista se topó: hay más cobros que los que vinieron. */
  has_more: boolean;
}

/** `[LE.6.37]` Ligar cobros ya capturados a UN depósito, en el orden dado. */
export interface LigarCobrosInput {
  cash_ledger_ids: string[];
}

/**
 * `[LE.6.37]` Todo o nada. Cada cobro toma lo que le falta mientras el depósito tenga libre; el
 * último puede quedar en parte (`sin_depositar`: lo que se queda en caja).
 */
export interface LigarCobrosResultado {
  ok: true;
  vinculos: Array<{ folio: string; monto: number; parcial: boolean }>;
  ligado: number;
  /** Lo que el depósito todavía tiene libre después de ligar. */
  libre: number;
  /** Lo que de esos cobros NO entró al depósito (se queda en caja). */
  sin_depositar: number;
}

/**
 * `[LE.6.37]` El reparto, puro, para que la pantalla y el servidor digan lo mismo: en orden, cada
 * cobro toma `min(falta, libre)`; un cobro que ya no alcanza nada no entra.
 */
export function repartirDeposito(
  libre: number,
  cobros: ReadonlyArray<{ id: string; falta: number }>,
): Array<{ id: string; monto: number; parcial: boolean }> {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  let queda = r2(Math.max(0, Number(libre) || 0));
  const out: Array<{ id: string; monto: number; parcial: boolean }> = [];
  for (const c of cobros) {
    const falta = r2(Math.max(0, Number(c.falta) || 0));
    const toma = r2(Math.min(falta, queda));
    if (toma <= 0) continue;
    out.push({ id: c.id, monto: toma, parcial: toma < falta - 0.005 });
    queda = r2(queda - toma);
  }
  return out;
}
