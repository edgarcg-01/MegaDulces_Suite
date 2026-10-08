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

// ─── [GP.3] La pantalla del surtidor: "tomar el siguiente" ────────────────────────────────────

/** Un renglón de la ola tal como lo ve el surtidor. */
export interface PickerWaveLine {
  id: string;
  product_id: string;
  product_name: string | null;
  sku: string | null;
  /** [GP.3] Código de barras del producto: lo que lee el escáner de la etiqueta. */
  barcode: string | null;
  /** Lo que se pide, en unidad BASE. */
  qty_requested: number;
  /** null = los pedidos la capturaron en unidades distintas (`unidad_mixta`). */
  qty_unit: string | null;
  unidad_mixta: boolean;
  /** Lo que dice la hoja (3 BTO). null = mezclada o sin presentación: contar en la unidad base. */
  qty_presentacion: number | null;
  unidad_presentacion: string | null;
  /** null = todavía nadie pasó por este renglón. */
  qty_picked: number | null;
  status: 'pendiente' | 'surtido' | 'faltante' | 'agotado' | 'danado';
  bin_code: string | null;
  note: string | null;
}

/** La ola que trae el surtidor, con sus renglones (lo pendiente primero). */
export interface PickerWave {
  id: string;
  code: string;
  warehouse_id: string;
  status: string;
  notes: string | null;
  started_at: string | null;
  /** Folios de los pedidos que van en la ola (`UD4001-0002840`, `PD-2026-00012`). */
  pedidos: string[];
  lines: PickerWaveLine[];
}

export type PickerTakeNextResponse =
  | {
      estado: 'asignada';
      /** true = ya la traía (cerró la app y volvió); false = se la acaba de dar el sistema. */
      ya_era_tuya: boolean;
      ola: PickerWave;
      /** Olas de la consola que no arrancaron al intentar tomarlas: se liberaron; avisar a la consola. */
      atoradas: Array<{ code: string; motivo: string }>;
    }
  | {
      estado: 'sin_trabajo';
      motivo: string;
      /** Lo que se intentó armar desde el pool de Kepler, con lo que quedó fuera y por qué. */
      armado: KeplerWavesAutoResponse | null;
      atoradas: Array<{ code: string; motivo: string }>;
    };
