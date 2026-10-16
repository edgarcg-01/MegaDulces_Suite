/**
 * `[CAT-COSTO.6–7]` Los tres costos de Kepler y la vista «Contra último costo» de
 * Compras › Catálogo › Costos.
 *
 * Definiciones de Compras (2026-10-14/15), verificadas contra el ERP — una sola vez, aquí, para que
 * ninguna pantalla vuelva a llamar «promedio» a lo que no lo es:
 *
 *  · **Costo estándar** — el del catálogo de productos de Kepler, sobre el que se aplica el margen
 *    (`kdii.c77`). Sólo cambia cuando alguien edita la ficha.
 *  · **Último costo** — el de la última compra que entró por **XA2001 Aplica Orden Entrada**. Los
 *    traspasos y los ajustes NO lo mueven.
 *  · **Costo promedio** — el que Kepler recalcula con cada entrada y le pone a cada venta en el
 *    kardex: es contra el que mide la utilidad.
 *  · **Costo de la última entrada** (`kdik.c16`) — sólo referencia. Lo mueve cualquier entrada
 *    (compra, traspaso o ajuste); NO es el promedio (medido: 98.57 % contra 0.02 %).
 *
 * Fuente: `analytics.mv_kepler_costos`. Todo en la unidad BASE de la ficha, sin impuesto.
 */

/** Tolerancia para decir que dos costos son iguales: ±1 %. */
export const TOLERANCIA_CONTRA_ULTIMO = 0.01;

/** El nombre y el significado de cada costo, para que la pantalla los diga igual en todos lados. */
export const COSTOS_KEPLER = {
  estandar: { nombre: 'Costo estándar', que_es: 'El del catálogo de productos de Kepler; sobre él se aplica el margen.' },
  ultimo: { nombre: 'Último costo', que_es: 'El de la última compra (XA2001 Aplica Orden Entrada). Traspasos y ajustes no cuentan.' },
  promedio: { nombre: 'Costo promedio', que_es: 'El que Kepler pone a cada venta en el kardex; contra él mide la utilidad.' },
  ultima_entrada: { nombre: 'Costo de la última entrada', que_es: 'Lo mueve cualquier entrada (compra, traspaso o ajuste). Sólo referencia.' },
} as const;

/** `[CAT-COSTO.10]` Los tres costos que tienen historia por día (la última entrada no). */
export type TipoCostoKepler = 'estandar' | 'promedio' | 'ultimo';

/** Resultado de comparar un costo entre almacenes: la MISMA regla de «Entre sucursales» (mayoría, ±0.5 %). */
export type VeredictoMatrizCostos = 'distinto' | 'sin_mayoria' | 'unidad_distinta' | 'igual' | 'una_plaza';

export const ETIQUETA_VEREDICTO_MATRIZ: Record<VeredictoMatrizCostos, string> = {
  distinto: 'Fuera de la mayoría',
  sin_mayoria: 'Sin mayoría',
  unidad_distinta: 'Unidad distinta',
  igual: 'Iguales',
  una_plaza: 'Un solo almacén',
};

/**
 * De dónde salió el costo de esa celda ese día.
 *  · `ficha`  — la foto nocturna del catálogo (estándar real).
 *  · `venta`  — estándar DEDUCIDO de lo que congeló la venta (antes de la primera foto).
 *  · `kardex` — promedio del kardex de ese día.
 *  · `xa2001` — la compra (último costo).
 */
export type FuenteCostoKepler = 'ficha' | 'venta' | 'kardex' | 'xa2001';

export interface CeldaMatrizCostos {
  sucursal: string;
  costo: number;
  /** Desde qué día rige ese valor (`YYYY-MM-DD`). */
  desde: string;
  fuente: FuenteCostoKepler;
  /** Folio de la XA2001 para el último costo. */
  referencia: string | null;
  unidad: string | null;
  /** Se sale de la mayoría más allá de la tolerancia (`null` sin mayoría). */
  fuera: boolean | null;
  desviacion_pct: number | null;
}

export interface FilaMatrizCostos {
  sku: string;
  nombre: string | null;
  proveedor_id: string | null;
  proveedor: string | null;
  celdas: CeldaMatrizCostos[];
  mayoria: number | null;
  /** % de los almacenes comparados que coinciden con la mayoría. `null` si no hay con qué comparar. */
  coincidencia_pct: number | null;
  diferencia_pct: number | null;
  veredicto: VeredictoMatrizCostos;
  /** Venta bruta de 30 días (la de HOY, para ordenar lo que más pesa primero). */
  venta_30d: number;
}

export interface RespuestaMatrizCostos {
  disponible: boolean;
  tipo: TipoCostoKepler;
  /** El día que se está viendo (`YYYY-MM-DD`). */
  fecha: string;
  /** El primer día con historia de este tipo de costo. */
  primera_fecha: string | null;
  calculado_al: string | null;
  tolerancia_pct: number;
  /**
   * Los almacenes, con el primer día que tienen dato de este costo. Un almacén cuya historia empieza
   * después de `fecha` estaba en Wincaja ese día: su columna se declara «sin dato», no en cero.
   */
  sucursales: { codigo: string; nombre: string | null; desde: string | null }[];
  resumen: Record<VeredictoMatrizCostos, number>;
  proveedores: { id: string; nombre: string; productos: number }[];
  total: number;
  filas: FilaMatrizCostos[];
}

/** Por qué falta un costo. Un costo ausente es `null` CON motivo, nunca 0. */
export type MotivoSinCosto = 'sin_estandar' | 'sin_compra' | 'sin_salida' | 'unidad_no_resuelta' | 'inverosimil';

/**
 * Resultado de comparar el estándar contra el último costo de compra.
 *  · `estandar_abajo`  — el estándar quedó por DEBAJO de lo que hoy se paga: el precio se armó con
 *                        un costo que ya no existe (el margen planeado sale mayor que el real).
 *  · `estandar_arriba` — el estándar quedó por ENCIMA de la última compra.
 *  · `igual`           — dentro de ±1 %.
 *  · `sin_compra`      — no hay XA2001 de ese producto en la red: no hay con qué comparar.
 *  · `unidad_no_clara` — la compra está en una unidad que la ficha no declara (o la razón es
 *                        inverosímil): va a la lista a depurar del analista de catálogo.
 *  · `sin_estandar`    — la ficha no tiene costo estándar.
 */
export type VeredictoContraUltimo =
  | 'estandar_abajo'
  | 'estandar_arriba'
  | 'igual'
  | 'sin_compra'
  | 'unidad_no_clara'
  | 'sin_estandar';

/** En el orden en que hay que atenderlos: lo que cuesta dinero primero, la meta al final. */
export const ORDEN_VEREDICTO_CONTRA_ULTIMO: readonly VeredictoContraUltimo[] = [
  'estandar_abajo',
  'estandar_arriba',
  'unidad_no_clara',
  'sin_compra',
  'sin_estandar',
  'igual',
];

export const ETIQUETA_VEREDICTO_CONTRA_ULTIMO: Record<VeredictoContraUltimo, string> = {
  estandar_abajo: 'Estándar abajo del último',
  estandar_arriba: 'Estándar arriba del último',
  igual: 'Igual',
  sin_compra: 'Sin compra',
  unidad_no_clara: 'Unidad no clara',
  sin_estandar: 'Sin estándar',
};

/** Qué tan vieja es la última compra. */
export type AntiguedadUltimo = 'hasta_90' | 'de_90_a_180' | 'mas_de_180';

export const ETIQUETA_ANTIGUEDAD_ULTIMO: Record<AntiguedadUltimo, string> = {
  hasta_90: 'Compra de los últimos 90 días',
  de_90_a_180: 'Compra de hace 90 a 180 días',
  mas_de_180: 'Compra de hace más de 180 días',
};

export interface FilaContraUltimo {
  sucursal: string;
  sku: string;
  nombre: string | null;
  proveedor_id: string | null;
  proveedor: string | null;
  unidad_base: string | null;
  costo_estandar: number | null;
  costo_ultimo: number | null;
  /** Fecha de la XA2001 (`c68`), `YYYY-MM-DD`. */
  ultimo_fecha: string | null;
  ultimo_folio: string | null;
  /** Proveedor que aparece en la XA2001 (puede diferir del proveedor del catálogo). */
  ultimo_proveedor: string | null;
  /** `propia` = compra de esta sucursal · `red` = la sucursal no compró; es la última de otra. */
  ultimo_origen: 'propia' | 'red' | null;
  /** Sucursal que hizo la compra. */
  ultimo_sucursal: string | null;
  /** Unidad en la que vino el renglón de la compra (para «unidad no clara»: contra `unidad_base`). */
  ultimo_unidad: string | null;
  antiguedad: AntiguedadUltimo | null;
  costo_promedio: number | null;
  /** `(último − estándar) / estándar`, en %, 1 decimal. `null` si no hay con qué comparar. */
  diferencia_pct: number | null;
  venta_30d: number;
  veredicto: VeredictoContraUltimo;
  motivo: MotivoSinCosto | null;
}

export interface ConteoContraUltimo {
  filas: number;
  venta_30d: number;
}

export interface RespuestaContraUltimo {
  /** `false` si la fuente nunca se ha calculado: entonces no hay filas ni conteos, y se dice. */
  disponible: boolean;
  /** Cuándo terminó el último cálculo de la fuente (ISO). */
  calculado_al: string | null;
  /** Hasta qué día llega la venta de 30 días. */
  venta_al: string | null;
  tolerancia_pct: number;
  /** Mismo universo que la tabla (texto, proveedor, sucursal, con/sin venta), sin veredicto ni antigüedad. */
  resumen: Record<VeredictoContraUltimo, ConteoContraUltimo>;
  /** Estándar abajo del último por MÁS de 5 %, partido por la antigüedad de la compra. */
  abajo_por_antiguedad: Record<AntiguedadUltimo, ConteoContraUltimo>;
  sucursales: { codigo: string; nombre: string | null }[];
  proveedores: { id: string; nombre: string; productos: number }[];
  total: number;
  filas: FilaContraUltimo[];
}
