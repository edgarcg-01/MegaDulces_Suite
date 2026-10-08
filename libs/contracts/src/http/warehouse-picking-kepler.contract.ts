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

// ─── [GP.3d] La entrega del surtido a Facturación (captura en Kepler) ─────────────────────────

/**
 * Dónde va cada pedido surtido en la Suite respecto a Kepler:
 *  · `por_capturar`: Kepler sigue en AUTORIZADO y faltó algo → Facturación corrige y pasa a SURTIDO.
 *  · `por_avanzar`: Kepler sigue en AUTORIZADO y salió completo → sólo pasar a SURTIDO.
 *  · `capturado`: Kepler ya está en SURTIDO (o más adelante) y sus cantidades cuadran con lo surtido.
 *  · `con_diferencias`: Kepler ya avanzó pero alguna cantidad no es la que se surtió.
 *  · `kepler_otro`: Kepler lo trae en otro estatus (cancelado, creado…) o no se encontró.
 */
export type CapturaKeplerEstado = 'por_capturar' | 'por_avanzar' | 'capturado' | 'con_diferencias' | 'kepler_otro';

/**
 * Un renglón que Facturación tiene que tocar: Kepler no trae lo que se surtió (faltó, el cliente lo
 * cambió durante el surtido, o Kepler trae un renglón que la Suite no surtió). Todas las cantidades
 * van en `unidad`: la presentación de Kepler (3 BTO) cuando se puede, si no la base.
 */
export interface CapturaKeplerRenglon {
  sku: string | null;
  producto: string | null;
  unidad: string | null;
  /** Lo que pidió el cliente (congelado al arrancar el surtido). */
  pedido: number;
  /** Lo que se surtió para este pedido: lo que debe quedar en Kepler. */
  surtido: number;
  /** pedido − surtido. */
  falta: number;
  /** Lo que Kepler trae HOY. 0 = ya no trae la clave. null = no se pudo leer Kepler. */
  kepler: number | null;
  /** true/false = Kepler trae lo surtido o no. null = no se pudo comparar. */
  cuadra: boolean | null;
  /** En cuántos renglones de Kepler viene la clave (más de 1: el TOTAL debe quedar en `surtido`). */
  renglones_kepler: number;
  /** Kepler trae este renglón y la Suite no lo surtió: hay que quitarlo. */
  extra: boolean;
}

export interface CapturaKeplerPedido {
  order_id: string;
  sucursal: string;
  /** Como se ve en Kepler: `UD4001-0002781`. */
  code: string;
  serie: number;
  folio: string;
  origen: string | null;
  destino: string | null;
  wave_code: string;
  /** Cuándo terminó el surtido en la Suite (ISO). */
  surtido_at: string;
  surtidores: string[];
  estado: CapturaKeplerEstado;
  /** Estatus que Kepler trae hoy (AUTORIZADO, SURTIDO…), o null si no se encontró. */
  estatus_kepler: string | null;
  renglones: number;
  /** Sólo los renglones que hay que tocar (faltantes) o que no cuadran. */
  pendientes: CapturaKeplerRenglon[];
}

export interface CapturaKeplerResponse {
  generado_en: string;
  /** De cuándo es lo último que llegó de Kepler (kdm1). null = no se pudo medir. */
  kepler_al: string | null;
  /** Días hacia atrás que se revisan: lo surtido antes no aparece aquí. */
  dias: number;
  /** Sucursales que ve quien consulta. Vacío = sin sucursal asignada (alcance fail-closed). */
  sucursales: string[];
  sin_alcance: boolean;
  pedidos: CapturaKeplerPedido[];
  /** Pedidos ya capturados que no se listan (de días anteriores): sólo el conteo. */
  capturados_antes: number;
  /** Surtidos terminados antes de GP.3 (sin lo pedido congelado): no se pueden comparar. */
  sin_congelado: number;
}

// ─── [GP.4] El checado: rastrillar, cajas P y etiquetas ───────────────────────────────────────

/** Un producto del pedido en el checado. Cantidades en la unidad BASE (`unidad`). */
export interface ChecadoRenglon {
  id: string;
  sku: string | null;
  producto: string | null;
  unidad: string | null;
  /** Lo surtido, que es lo que ya está en Kepler: lo que debe salir. */
  esperado: number;
  /** Lo que lleva escaneado el checador. */
  checado: number;
  /** La caja del producto (CJA) y cuántas piezas trae. null = sólo se vende suelto. */
  unidad_mayor: string | null;
  factor_mayor: number | null;
  /** Cajas cerradas que se esperan (sólo si lo esperado da cajas enteras). */
  esperado_mayor: number | null;
  /** Cajas escaneadas. */
  checado_mayor: number;
  /** Se vende por kilo: el escaneo pide el peso de la báscula. */
  se_pesa: boolean;
  estado: 'pendiente' | 'completo' | 'falta' | 'sobra';
}

export interface ChecadoContenido {
  sku: string | null;
  producto: string | null;
  unidad: string | null;
  cantidad: number;
}

/** Una caja de paquetería (P1, P2…) y lo que lleva. */
export interface ChecadoCajaP {
  id: string;
  numero: number;
  status: 'abierta' | 'cerrada';
  contenido: ChecadoContenido[];
}

export interface ChecadoPedido {
  id: string;
  order_code: string;
  destino: string | null;
  sucursal: string;
  warehouse_id: string;
  started_at: string;
  renglones: ChecadoRenglon[];
  cajas_p: ChecadoCajaP[];
  /** El último escaneo vigente (para "Deshacer"). */
  ultimo_escaneo: { id: string; producto: string | null; unidad: string | null; cantidad: number; kind: 'mayor' | 'menor' | 'ajeno' } | null;
}

export type ChecadoTomarResponse =
  | { estado: 'asignado'; ya_era_tuyo: boolean; pedido: ChecadoPedido }
  | {
      estado: 'sin_trabajo';
      motivo: string;
      /** Pedidos surtidos que esperan a que Facturación los pase a SURTIDO en Kepler. */
      esperando_facturacion: number;
    };

export type ChecadoEscaneoResultado = 'ok' | 'sobra' | 'ajeno' | 'desconocido' | 'ambiguo' | 'pide_peso';

export interface ChecadoEscaneoResponse {
  resultado: ChecadoEscaneoResultado;
  mensaje: string;
  producto: string | null;
  pedido: ChecadoPedido;
}

/** Lo que va en la etiqueta de una caja P (sale por triplicado al cerrarla). */
export interface ChecadoEtiquetaP {
  id: string;
  numero: number;
  order_code: string;
  destino: string | null;
  articulos: number;
  productos: number;
}

/** Una etiqueta de unidad mayor: "3/7". */
export interface ChecadoEtiquetaCJ {
  n: number;
  total: number;
  sku: string | null;
  producto: string | null;
  unidad: string | null;
}

export interface ChecadoCerrarCajaResponse {
  etiqueta: ChecadoEtiquetaP;
  pedido: ChecadoPedido;
}

export interface ChecadoTerminarResponse {
  order_code: string;
  destino: string | null;
  /** Sólo lo que no cuadra: lo que sale es lo checado. */
  diferencias: Array<{ sku: string | null; producto: string | null; unidad: string | null; esperado: number; checado: number }>;
  etiquetas_cj: ChecadoEtiquetaCJ[];
  /** La caja P que seguía abierta y se cerró al terminar (su etiqueta sale aquí). */
  etiqueta_p: ChecadoEtiquetaP | null;
  cajas_p: number;
}
