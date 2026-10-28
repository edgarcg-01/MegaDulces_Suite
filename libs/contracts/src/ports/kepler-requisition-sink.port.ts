/**
 * `[KR.0]` — **El puerto por el que una requisición de la Suite sale hacia Kepler.**
 *
 * Plan: [`FASE_KR_REQUISICION_A_KEPLER.md`](../../../../docs/IMPLEMENTACION/FASES/FASE_KR_REQUISICION_A_KEPLER.md).
 *
 * ── Por qué existe, y qué regla levanta ─────────────────────────────────────────────────────
 *
 * ADR-016 dice que la plataforma **no escribe al ERP** ([`FASE_RA`
 * §226](../../../../docs/IMPLEMENTACION/FASES/FASE_RA_REABASTECIMIENTO.md)). Ésta es la primera
 * excepción autorizada —decisión de Edgar del 2026-10-13— y queda documentada como tal, no como
 * un descuido. La propia regla la previó: *"fuera de scope hasta decisión explícita"*.
 *
 * Lo que la hace viable es que se midió antes de construir: se escribió a mano una requisición
 * `X-A-30` en `md_00` y **Kepler la mostró completa**. O sea que `kdm1` + `kdm2` alcanzan.
 *
 * ── Por qué un puerto y no una llamada directa ──────────────────────────────────────────────
 *
 * Porque escribir en el ERP es justo la clase de cosa que uno quiere poder APAGAR sin tocar a
 * quien arma la requisición. Sin binding, `createRequisition` funciona igual y la requisición
 * vive sólo en la Suite — el comportamiento de siempre, y un estado legítimo.
 *
 * ⭐ `entregada` NO significa "Kepler la tiene bien". Significa que el INSERT entró. Mismo
 * principio que `[CP.8.5]`: un sink entrega, no afirma.
 *
 * ⛔ **Y un sink no es idempotente.** Llamarlo dos veces escribe dos documentos: pasó el
 * 2026-10-13, cuatro veces con la misma requisición. Quien llama DEBE mirar
 * `purchase_requisitions.kepler_folio` antes (mig `20261013140000`).
 */

export const KEPLER_REQUISITION_SINK_PORT = 'KEPLER_REQUISITION_SINK_PORT';

/**
 * Un renglón **en el idioma de la Suite**: cajas y costo por caja. Se escribe **tal cual**, en
 * unidad `CJA`, sin convertir.
 *
 * ⭐⭐ `[KR.6]` **Por qué NO se convierte a la unidad de la ficha** (decisión 2026-10-14, tras
 * revertir el diseño anterior):
 *
 * El argumento para convertir era la fidelidad: Kepler usa `PAQ` en 508 de nuestros 714 SKUs,
 * `PZA` en 154 y `KG` en 39 — `CJA` sólo en 4. Su precio es una multiplicación por un factor de
 * caja, y **ese factor no se pudo fijar en tres intentos**: `kdm2.c58` resultó ser otra pregunta
 * (el empaque *de esa compra*, no la caja del producto) y `kdii.c84` dio 50.4% de acuerdo en una
 * medición que además estaba mal hecha (`kdii` tiene una fila por sucursal×producto y se comparó
 * contra una plaza arbitraria). **La fidelidad no vale una multiplicación que no se puede
 * verificar**: convertir mal en silencio es peor que una etiqueta inusual.
 *
 * ⭐ Y escribir `CJA` está probado de punta a punta: de las 22 requisiciones históricas con
 * unidad `CJA`, **las 22** recorrieron requisición → OC → vale → **entrada de inventario**, con
 * razón de cantidad **1.0000** y la unidad preservada. Kepler **no convierte entre documentos**:
 * copia el renglón.
 *
 * ⚠️ Lo que se pierde, declarado: en el documento la unidad dirá `CJA` mientras la ficha del
 * producto dice `PAQ`/`PZA`/`KG`. Es **visible**, y la cantidad significa exactamente lo que la
 * persona capturó.
 */
export interface KeplerRequisitionLine {
  /** SKU tal como lo conoce Kepler (`kdm2.c8`). */
  sku: string;
  /** Descripción del artículo (`c10`). */
  nombre: string;
  /** Cantidad **en cajas** — `purchase_requisition_lines.final_qty`, que ya viene en cajas. */
  cajas: number;
  /**
   * `[PQ.17]` Piezas por caja del producto (resolvedor canónico). Si `cajas` trae fracción y
   * `cajas × piezas_por_caja` es entero, el adapter escribe el renglón en la **unidad base** de
   * Kepler (la mesa deja capturar en piezas). Sin factor, sólo valen cajas enteras.
   */
  piezas_por_caja?: number | null;
  /** Costo de UNA caja (`unit_cost`). */
  costo_caja: number;
  /** Importe del renglón (`line_cost`). El adapter no lo re-deriva. */
  importe: number;
}

/**
 * `[KR.10]` Qué documento de Kepler se va a escribir. **No son el mismo con otro código**:
 * `compra` → `X-A-30` Requisición · `traspaso` → `U-D-40` Pedido.
 */
export type KeplerDoctipo = 'compra' | 'traspaso';

export interface KeplerRequisitionEntrada {
  /** Identidad del lado de la Suite. Es lo que permite reconocer el documento dentro del ERP. */
  requisition_id: string;
  folio_suite: string;
  /** Qué documento escribir. Lo decide `source_type` de la requisición. */
  tipo: KeplerDoctipo;
  /** Sucursal Kepler donde se CREA el documento (`commercial.warehouses.kepler_code`). */
  sucursal: string;
  /** `compra`: código del proveedor (`catalog.suppliers.code` → `kdm1.c10`). */
  proveedor_code?: string;
  proveedor_nombre?: string;
  /**
   * `traspaso`: `kepler_code` del almacén **DESTINO**. El adapter lo traduce al pseudo-cliente
   * `TI###` leyendo `md.pv_suc_ip` — ⛔ **no se infiere del número** (`02`→`TI008`, `03`→`TI002`).
   */
  destino_sucursal?: string;
  /** `YYYY-MM-DD` en hora de México. */
  fecha: string;
  lineas: KeplerRequisitionLine[];
  /** Importe total del documento (`c16`). */
  total: number;
  /**
   * `[PQ.20]` Tope diario que decidió la Suite (`commercial.kepler_push_switch`). `null` = sin
   * tope; ausente = el de la variable `KEPLER_PUSH_MAX_DIA_NN` (antes de la migración).
   */
  tope_dia?: number | null;
}

/** `[KR.6]` Qué unidad resolvió el adapter para un SKU, o por qué no pudo. */
export interface KeplerLineaResuelta {
  sku: string;
  /** Unidad de la línea en Kepler (`c11`). */
  unidad?: string;
  /** Unidad de la caja (`c55`) y cuántas `unidad` entran en ella (`c58`). */
  unidad_caja?: string;
  por_caja?: number;
  /** Cantidad finalmente escrita, en `unidad`. */
  cantidad?: number;
  /** Presente sólo si NO se pudo resolver. La requisición entera se rechaza. */
  motivo?: string;
}

export interface KeplerRequisitionResultado {
  /**
   * `entregada` = el INSERT entró. `rechazada` = no entró y **nada quedó escrito** (una sola
   * transacción).
   */
  estado: 'entregada' | 'rechazada';
  motivo?: string;
  /** La coordenada con la que Kepler identifica el documento. Sólo si `entregada`. */
  kepler?: { sucursal: string; folio: string; renglones: number };
  /**
   * ⭐ Qué unidad se usó por renglón, o cuáles no se pudieron resolver. Se devuelve **en los dos
   * casos**: en el feliz es la evidencia de con qué se escribió; en el de rechazo es la lista de
   * SKUs que hay que dar de alta en Kepler. Sin esto, "no se pudo" no dice qué arreglar.
   */
  lineas?: KeplerLineaResuelta[];
}

export interface KeplerRequisitionSinkPort {
  /**
   * ¿Se puede escribir AHORA? `false` si no hay credencial o el ERP no responde.
   * **Nunca lanza**: un ERP caído es un dato, no una excepción.
   */
  disponible(): Promise<boolean>;

  /**
   * Escribe la requisición en Kepler. Todo o nada: una sola transacción contra el ERP.
   * No valida reglas de negocio — eso ya lo hizo `insertRequisition`.
   */
  entregar(entrada: KeplerRequisitionEntrada): Promise<KeplerRequisitionResultado>;
}
