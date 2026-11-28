/**
 * `[ICR.K0]` — **El puerto por el que el ajuste de un inventario físico sale hacia Kepler.**
 *
 * Plan: [`FASE_ICR_ANEXO_ANATOMIA_INVENTARIO_FISICO_KEPLER_2026-11-27.md`](../../../../docs/IMPLEMENTACION/FASES/FASE_ICR_ANEXO_ANATOMIA_INVENTARIO_FISICO_KEPLER_2026-11-27.md).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * Hasta hoy el ciclo lo cerraba una persona: `GET /counts/:id/kepler-export` armaba un archivo y
 * alguien lo capturaba en el ERP. **Nunca se usó** — `inventory_kepler_exports` está vacía — y
 * mientras no se capture, Kepler sigue con su saldo viejo y el siguiente folio vuelve a encontrar
 * la misma diferencia. Decisión de Edgar (PM) del 2026-11-27: *«nosotros vamos a escribir en
 * Kepler lo necesario»*.
 *
 * Es la segunda excepción autorizada a ADR-016/ADR-040 (la primera fue la requisición `X-A-30`,
 * 2026-10-13) y queda documentada como tal.
 *
 * ── Qué escribe: TRES documentos en UNA transacción ─────────────────────────────────────────
 *
 * Así lo hace Kepler, medido sobre los 9 inventarios de septiembre de 2026:
 *
 * | | qué lleva | ¿mueve existencia? |
 * |---|---|---|
 * | `N-A-45` **Captura inventario físico** | TODO lo contado | **no** (0 filas de kardex en 123 de 123 actas) |
 * | `N-A-30` **Entrada Inventario físico** | los sobrantes | **sí** (108 de 108 con kardex `E`) |
 * | `N-D-30` **Salida inventario físico** | los faltantes | **sí** (94 de 94 con kardex `S`) |
 *
 * El acta va primero porque los otros dos **la referencian por folio** (`kdm1.c11`), y los tres
 * viajan en la misma transacción: o están los tres, o no está ninguno. Un acta sin sus
 * movimientos sería un conteo que no ajustó; un movimiento sin acta, un ajuste sin explicación.
 *
 * ⭐ Y la entrada o la salida pueden **no escribirse** legítimamente: si nada sobró, no hay
 * `N-A-30`. Pasó de verdad — 00, 07 y 08 cerraron su inventario de septiembre **sin salida**.
 *
 * ── Qué NO recibe, y por qué ────────────────────────────────────────────────────────────────
 *
 * ⛔⛔ **No recibe la diferencia: recibe lo CONTADO.** La diferencia la calcula el adapter contra
 * la existencia del propio Kepler, leída dentro de la transacción que escribe. Mandarla hecha
 * sería ajustar el ERP con el saldo de otro libro: `commercial.stock` está muerta por decisión
 * (`[CANON.7.5]`) y el censo de `[CANON.7.4d]` midió **31 % de celdas discrepantes, $22.1 M**.
 * Si el ERP se movió entre el conteo y la escritura, lo que tiene que ganar es el ERP — si no, el
 * ajuste deja una diferencia nueva en lugar de cerrar la vieja.
 *
 * ⭐ `entregada` NO significa «Kepler lo tiene bien»: significa que los INSERT entraron. Mismo
 * principio que `[CP.8.5]` y que el sink de la requisición: un sink entrega, no afirma.
 *
 * ⛔ **Y un sink no es idempotente.** Llamarlo dos veces escribe dos juegos de documentos y
 * **ajusta dos veces** — acá el daño es doble, porque la segunda corrida encuentra la existencia
 * ya corregida y genera la diferencia contraria. Quien llama DEBE mirar primero si el folio ya
 * tiene su coordenada de Kepler guardada.
 */

export const KEPLER_INVENTORY_ADJUSTMENT_SINK_PORT = 'KEPLER_INVENTORY_ADJUSTMENT_SINK_PORT';

/** Un SKU contado, en el idioma del piso: cuántas unidades base aparecieron. */
export interface KeplerInventarioLinea {
  /** SKU tal como lo conoce Kepler (`kdm2.c8`). */
  sku: string;
  /** Descripción del artículo (`kdm2.c10`). */
  nombre: string;
  /**
   * Lo que se contó, **en la unidad BASE de Kepler** (`kdii.c11`, el primer peldaño de la
   * escalera). ⛔ No en cajas: el acta de Yurécuaro usa la unidad base en 1,549 de 1,567
   * renglones (98.9 %), y el adapter contrasta la unidad contra la ficha antes de escribir.
   */
  contado: number;
}

export interface KeplerInventarioEntrada {
  /** Identidad del lado de la Suite: `commercial.inventory_counts.id`. */
  count_id: string;
  /** `INV-2026-00007`. Es la marca que va a `kdm1.c24` de los tres documentos. */
  folio_suite: string;
  /** Sucursal Kepler donde se CREAN los documentos (`commercial.warehouses.kepler_code`). */
  sucursal: string;
  /** `YYYY-MM-DD` en hora de México. */
  fecha: string;
  /**
   * Qué se contó, para `kdm1.c11` del acta (`T02`, `RESTOS`, `B04`…). Opcional: 120 de 312 actas
   * lo dejan vacío. ⛔ No viaja a la entrada ni a la salida: ahí `c11` es la liga al acta.
   */
  zona?: string;
  /** Todo lo contado. Lo que no se contó **no se manda**: un no-contado no es un cero. */
  lineas: KeplerInventarioLinea[];
  /** Tope diario del servidor (`commercial.kepler_push_switch`, tipo `inventario_fisico`). `null` = sin tope. */
  tope_dia?: number | null;
}

/** Qué resolvió el adapter para un SKU: lo contado, lo que Kepler creía, y la diferencia que escribió. */
export interface KeplerInventarioDiferencia {
  sku: string;
  contado: number;
  /** Existencia de Kepler **en el momento de escribir** (`kdil.c4 + c8 − c9`, piso 0). */
  existencia: number;
  /** `contado − existencia`. > 0 → entrada · < 0 → salida · 0 → no generó renglón. */
  diferencia: number;
  /** Costo unitario con el que se valuó el renglón. ⚠️ Su fuente es `kdik.c16` y **NO está confirmada** — ver `costo_no_confirmado` del resultado. */
  costo?: number;
  /** Presente sólo si el SKU NO se pudo resolver (sin ficha en Kepler). La escritura entera se rechaza. */
  motivo?: string;
}

/** La coordenada de un documento escrito. */
export interface KeplerInventarioDocumento {
  folio: string;
  renglones: number;
  importe: number;
}

export interface KeplerInventarioResultado {
  /** `entregada` = los INSERT entraron. `rechazada` = **nada** quedó escrito (una sola transacción). */
  estado: 'entregada' | 'rechazada';
  motivo?: string;
  kepler?: {
    sucursal: string;
    serie: string;
    /** Siempre, si se entregó. */
    acta: KeplerInventarioDocumento;
    /** Ausente si nada sobró. */
    entrada?: KeplerInventarioDocumento;
    /** Ausente si nada faltó. */
    salida?: KeplerInventarioDocumento;
  };
  /**
   * ⭐ Qué se resolvió por SKU. Se devuelve **en los dos casos**: entregado es la evidencia de con
   * qué se ajustó, y rechazado es la lista de lo que hay que arreglar. Sin esto, «no se pudo» no
   * dice qué corregir.
   */
  diferencias?: KeplerInventarioDiferencia[];
  /**
   * ⛔ **Verdad declarada (ADR-056).** `true` siempre, hasta que se cierre de dónde saca Kepler el
   * costo del renglón del acta. Medido el 2026-11-27 contra el acta de Yurécuaro: `kdm2.c12`
   * coincide con `kdik.c16` en **933 de 1,567 (59.5 %)**, y el control que explicaría la brecha
   * —que el costo se movió después del conteo— **falla**: entre los 634 que difieren, 37.2 % tuvo
   * una entrada posterior al 17-sep, contra 29.8 % entre los 933 que coinciden. Casi lo mismo.
   * La valuación que escribimos es la mejor disponible del propio ERP, **no una medida**.
   */
  costo_no_confirmado?: boolean;
}

export interface KeplerInventoryAdjustmentSinkPort {
  /** ¿Se puede escribir AHORA? **Nunca lanza**: un ERP caído es un dato, no una excepción. */
  disponible(): Promise<boolean>;
  /** Escribe el ajuste. Todo o nada: una sola transacción contra el ERP. */
  entregar(entrada: KeplerInventarioEntrada): Promise<KeplerInventarioResultado>;
}
