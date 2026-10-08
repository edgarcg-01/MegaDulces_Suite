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
  /**
   * [GP.3c] Existencia en sistema en el almacén de la ola (Kepler, unidad BASE). null = no se pudo
   * medir (sin ficha o sin dato), que NO es lo mismo que 0.
   */
  existencia: number | null;
  /** Unidad de esa existencia (kdii.c11). Si difiere de `qty_unit`, la pantalla no compara. */
  existencia_unidad: string | null;
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
  /** [GP.3c] De cuándo es la existencia (último dato de kdil). null = no se pudo medir. */
  existencia_al: string | null;
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

// ─── [GP.3c] La consola de surtido: quién prioriza la fila ────────────────────────────────────

/** Un surtido en la fila, en el ORDEN en que "Tomar siguiente" los va a dar. */
export interface ConsolaSurtidoOla {
  id: string;
  code: string;
  /** abierta = nadie la ha empezado; en_surtido = alguien la está surtiendo. */
  status: string;
  origen: string | null;
  armada_por: 'consola' | 'auto';
  /** 1 = urgente: va antes que todo. */
  prioridad: 0 | 1;
  prioridad_motivo: string | null;
  assigned_to: string | null;
  /** Nombre de quien la trae; null = libre. */
  assigned_nombre: string | null;
  created_at: string;
  started_at: string | null;
  /**
   * true = "Tomar siguiente" la puede dar: libre y abierta, o liberada desde la consola. Una en
   * surtido sin dueño que arrancó la pantalla de Reparto NO es tomable: alguien la está caminando.
   */
  tomable: boolean;
  renglones: number;
  tocados: number;
  pedidos: string[];
  destinos: string[];
  /** La salida más próxima de sus destinos hoy (`HH:MM`), o null si nadie la capturó. */
  hora_salida: string | null;
}

/** Un destino con pedidos hoy: aquí el coordinador captura su hora de salida. */
export interface ConsolaSurtidoDestino {
  destino_code: string;
  destino_nombre: string | null;
  /** Pedidos autorizados en Kepler que todavía no entran a ningún surtido. */
  por_armar: number;
  /** Pedidos ya en un surtido abierto o en curso. */
  en_surtido: number;
  hora_salida: string | null;
}

export interface ConsolaSurtidoResponse {
  warehouse_id: string;
  sucursal: string;
  /** `YYYY-MM-DD` (MX): el día de las horas de salida. */
  fecha: string;
  umbral_tanda: number;
  olas: ConsolaSurtidoOla[];
  /** Surtidos terminados hoy (sólo el conteo: la consola es para lo que falta). */
  surtidas_hoy: number;
  /** Pedidos autorizados en Kepler que todavía no se arman en surtidos. */
  por_armar: {
    pedidos: number;
    tanda: number;
    individual: number;
    bloqueados: number;
    atorados: { count: number; desde: string | null };
  };
  destinos: ConsolaSurtidoDestino[];
}

/** Un almacén que el coordinador puede manejar (los de su alcance, sucursales de 2 dígitos). */
export interface ConsolaSurtidoAlmacen {
  id: string;
  code: string;
  nombre: string;
}
