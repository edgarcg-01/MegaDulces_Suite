/**
 * `[GP.2]` La FORMA del wire del pool de surtido con pedidos de KEPLER (`U-D-40`).
 *
 * El pedido se LEE del ODS y no se copia (ADR-086); la ola sólo guarda su llave
 * `(sucursal, serie, folio)` y un `order_id` derivado de ella. La lógica vive en
 * `libs/commercial/src/lib/commercial-picking/kepler-origen.ts`; acá sólo la forma.
 */

/**
 * Regla de surtido de Francisco (`FASE_GP` §5.1): hasta 5 renglones se surte en tanda con otros
 * pedidos chicos; de 6 en adelante, el pedido va solo.
 */
export type KeplerPickSize = 'tanda' | 'individual';

export interface KeplerPickPoolRow {
  /** UUID derivado de la llave: `md5('kepler/UD40/<suc>/<serie>/<folio>')::uuid`. */
  id: string;
  source: 'kepler';
  sucursal: string;
  serie: number;
  folio: string;
  /** Como se ve en Kepler: `UD4001-0002781`. */
  code: string;
  /** `YYYY-MM-DD`. */
  fecha: string;
  hora: string | null;
  /** `TELEMARK`, `SUCURSAL`, u otro valor crudo si Kepler trae algo nuevo. */
  origen: string | null;
  estatus: string | null;
  cliente_code: string | null;
  /** Nombre del destino tal como lo trae el pedido (`c32`). */
  customer_name: string | null;
  total: number | null;
  /** Renglones del pedido. */
  lines: number;
  /** Suma de cantidades en la unidad BASE de cada renglón (mezcla unidades: sólo orienta). */
  units: number;
  tamano: KeplerPickSize;
  /** Renglones cuya clave no está en el catálogo: el pedido no puede entrar a una ola. */
  sin_catalogo: number;
}

export interface KeplerPickPoolResponse {
  data: KeplerPickPoolRow[];
  count: number;
  sucursal: string;
  /** Primer día de la ventana, `YYYY-MM-DD` (MX). */
  desde: string;
  umbral_tanda: number;
  /** Pedidos que siguen AUTORIZADO en Kepler con fecha anterior a `desde`: fuera del pool, contados. */
  atorados: { count: number; desde: string | null };
}

/** Una ola tal como la devuelve el alta (`commercial.picking_waves` + conteo de pedidos). */
export interface PickingWaveCreated {
  id: string;
  code: string;
  warehouse_id: string;
  status: string;
  notes: string | null;
  orders_count: number;
}

export interface KeplerWavesAutoResponse {
  creadas: PickingWaveCreated[];
  /** Olas que no se pudieron crear (p. ej. otra sesión se llevó el pedido), con su motivo. */
  fallidas: Array<{ pedidos: string[]; motivo: string }>;
  /** Pedidos que no entran a ninguna ola, con su motivo (clave fuera del catálogo). */
  bloqueados: Array<{ code: string; motivo: string }>;
  /** Pedidos autorizados sin renglones: no hay nada que caminar. */
  vacios: string[];
  atorados: { count: number; desde: string | null };
}
