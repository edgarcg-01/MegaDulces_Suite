/**
 * `[CAT-PRECIO.1]` Compras › Catálogo › Precios › **Diferencias entre sucursales**.
 *
 * La ficha de venta de un producto («Productos POS» de Kepler) tiene que ser la misma en todas las
 * sucursales. Esta vista compara campo por campo y dice qué plaza se sale.
 *
 * ⚠️ La referencia es la MAYORÍA de las sucursales, y es PROVISIONAL. Lo que manda es el Sistema
 * Concentrador de Kepler (decisión de Compras, 2026-10-16), pero su base no llega al ODS: sólo
 * llegan las sucursales 00–08. Cuando llegue, `referencia` pasa a `'concentrador'` y la pantalla no
 * cambia de forma. Mientras tanto se publica la fecha del último cambio de precio de cada plaza,
 * porque la mayoría puede ser justo la que se quedó con el precio viejo.
 */

/** Los campos de la ficha que se comparan, en el orden en que la pantalla los muestra. */
export type CampoFicha =
  | 'precio1'
  | 'precio2'
  | 'precio3'
  | 'mayoreo'
  | 'unidades'
  | 'iva'
  | 'ieps'
  | 'linea'
  | 'tipo'
  | 'grupo'
  | 'descripcion'
  | 'barras';

export const CAMPOS_FICHA: readonly { campo: CampoFicha; nombre: string; que_es: string }[] = [
  { campo: 'precio1', nombre: 'Precio unidad base', que_es: 'El precio de venta de la unidad base de la ficha, con impuestos.' },
  { campo: 'precio2', nombre: 'Precio unidad 2', que_es: 'El precio de venta de la segunda unidad (p. ej. la caja), con impuestos.' },
  { campo: 'precio3', nombre: 'Precio unidad 3', que_es: 'El precio de venta de la tercera unidad, con impuestos.' },
  { campo: 'mayoreo', nombre: 'Precio por volumen', que_es: 'El precio estándar por volumen (nivel 0): desde cuántas unidades y a cuánto.' },
  { campo: 'unidades', nombre: 'Unidades y factores', que_es: 'Las unidades de la ficha y cuántas unidades base trae cada una.' },
  { campo: 'iva', nombre: 'IVA', que_es: 'La tasa de IVA de la ficha.' },
  { campo: 'ieps', nombre: 'IEPS', que_es: 'La tasa de IEPS de la ficha.' },
  { campo: 'linea', nombre: 'Línea', que_es: 'La línea del producto en Kepler.' },
  { campo: 'tipo', nombre: 'Tipo', que_es: 'El tipo del producto en Kepler.' },
  { campo: 'grupo', nombre: 'Grupo', que_es: 'El grupo del producto en Kepler.' },
  { campo: 'descripcion', nombre: 'Descripción', que_es: 'El nombre del producto tal como está escrito en la ficha.' },
  { campo: 'barras', nombre: 'Códigos de barras', que_es: 'Los códigos de barras de cada unidad.' },
];

/** Contra qué se compara. Hoy sólo existe `mayoria`; `concentrador` llega cuando su base esté en el ODS. */
export type ReferenciaFicha = 'mayoria' | 'concentrador';

/**
 * `distinto` — hay una mayoría y al menos una plaza se sale de ella.
 * `sin_mayoria` — dos o más valores empatan: elegir uno sería afirmar cuál es el bueno sin evidencia.
 */
export type VeredictoCampoFicha = 'distinto' | 'sin_mayoria';

export interface ValorCampoPlaza {
  sucursal: string;
  /** Lo que dice la ficha de esa plaza, ya escrito para leerse. `'—'` = la ficha no tiene ese dato. */
  texto: string;
  /** Se sale de la mayoría. `null` cuando no hay mayoría contra la cual medir. */
  fuera: boolean | null;
}

export interface DiferenciaCampoFicha {
  campo: CampoFicha;
  veredicto: VeredictoCampoFicha;
  /** El valor de la mayoría. `null` en `sin_mayoria`. */
  mayoria: string | null;
  sucursales_fuera: string[];
  /** Sólo en los precios: la brecha entre el más caro y el más barato, en %. */
  diferencia_pct: number | null;
  valores: ValorCampoPlaza[];
}

export interface CambioPrecioPlaza {
  sucursal: string;
  /** El último cambio REAL de precio (al centavo) en la bitácora de Kepler, `YYYY-MM-DD`. `null` = sin registro. */
  fecha: string | null;
}

export interface FilaFichaSucursales {
  sku: string;
  /** La descripción de la mayoría (o la primera, si no hay mayoría). */
  nombre: string;
  plazas: number;
  /** Venta de los últimos 30 días en la red; ordena la tabla: primero lo que más se vende. */
  venta_30d: number;
  /** Sólo los campos que NO coinciden, en el orden de `CAMPOS_FICHA`. */
  campos: DiferenciaCampoFicha[];
  /** Último cambio de precio de cada plaza, para saber quién movió el precio al último. */
  cambios: CambioPrecioPlaza[];
  /** La plaza con el cambio de precio más reciente, si hay uno solo más reciente que los demás. */
  cambio_mas_reciente: { sucursal: string; fecha: string } | null;
}

export interface ConsultaFichaSucursales {
  q?: string;
  campo?: CampoFicha;
  /** Sólo los productos donde esta plaza se sale de la mayoría en algún campo. */
  sucursal?: string;
  limite?: number;
  desplazamiento?: number;
}

export interface RespuestaFichaSucursales {
  referencia: ReferenciaFicha;
  /**
   * Cuándo recibió el ODS la última pasada de la ficha (`kepler_ods._sync_status` de `kdii`). El
   * carril empuja aunque no haya cambios, así que mide si el espejo está vivo, no si alguien editó.
   * `null` = no hay registro: la pantalla lo declara en vez de suponer que está al día.
   */
  ficha_al: string | null;
  /** Las plazas comparadas (venden al público), con su nombre. */
  sucursales: { codigo: string; nombre: string }[];
  /** Productos con ficha en 2 o más plazas: el denominador. */
  productos_comparados: number;
  /** Productos con al menos un campo distinto, por campo. Mismo universo que la tabla salvo `campo` y `sucursal`. */
  resumen: Record<CampoFicha, number>;
  /** Productos con al menos un campo distinto (búsqueda aplicada, sin `campo` ni `sucursal`). */
  con_diferencias: number;
  /** Filas que pasan TODOS los filtros, antes de paginar. */
  total: number;
  filas: FilaFichaSucursales[];
}
