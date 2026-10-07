import { PriceReportRow } from '../comercial/comercial.service';

/**
 * `[CAT.7]` **Qué columnas puede llevar el reporte de precios**, y cómo se escribe cada celda.
 *
 * Vive fuera del componente por la razón de siempre en este repo: el formato de una celda de
 * dinero es donde se cuelan los errores que nadie ve —un `0` donde no hay dato, un mayoreo sin su
 * umbral, un precio de caja mostrado como precio de pieza— y adentro de una plantilla de Angular
 * no se puede probar sin montar el componente entero.
 *
 * ── La regla que gobierna todo este archivo ────────────────────────────────────────────────
 * **Lo que no hay se escribe `—`, nunca `$0.00`.** En una hoja impresa que se lleva a negociar
 * con el proveedor, un cero es un precio y se defiende como tal.
 */

/** Cada apartado que el usuario puede tildar. */
export type ColumnaReporteId =
  | 'sku'
  | 'barcode'
  | 'marca'
  | 'contenido'
  | 'unidad'
  | 'precio_unidad'
  | 'mayoreo_unidad'
  | 'paquete'
  | 'mayoreo_paquete'
  | 'caja'
  | 'costo';

export interface ColumnaReporte {
  id: ColumnaReporteId;
  /** Encabezado de la columna, tal cual sale impreso. */
  label: string;
  /** `identidad` = de qué producto hablamos · `precio` = la matriz de Kepler · `costo` = lo que nos cuesta. */
  grupo: 'identidad' | 'precio' | 'costo';
  /** Lo que la columna afirma. Se muestra como ayuda al tildarla y explica su unidad. */
  ayuda: string;
  /** Alineada a la derecha con cifras tabulares (dinero y cantidades). */
  num: boolean;
}

/**
 * El catálogo, en el orden en que sale impreso.
 *
 * ⚠️ `precio_unidad` es el precio de la **unidad base** del producto en Kepler, que NO siempre es
 * la pieza: en los SKUs con base `PAQ` ese renglón ya es el paquete. Por eso la columna `unidad`
 * viene tildada por default — sin ella, la cifra no dice de qué es.
 */
export const COLUMNAS_REPORTE: readonly ColumnaReporte[] = [
  { id: 'sku', label: 'SKU', grupo: 'identidad', num: false, ayuda: 'Código del producto en Kepler.' },
  { id: 'barcode', label: 'Código de barras', grupo: 'identidad', num: false, ayuda: 'El código de la unidad base, el que escanea la caja.' },
  { id: 'marca', label: 'Marca', grupo: 'identidad', num: false, ayuda: 'Marca del catálogo.' },
  { id: 'contenido', label: 'Contenido', grupo: 'identidad', num: false, ayuda: 'Gramaje declarado en el nombre del producto (ej. 500 g).' },
  { id: 'unidad', label: 'Unidad', grupo: 'identidad', num: false, ayuda: 'La unidad BASE de Kepler (PZA, PAQ, CJA, KG). Es de lo que habla el precio unitario.' },
  { id: 'precio_unidad', label: 'Precio unidad', grupo: 'precio', num: true, ayuda: 'Precio de una unidad base. Si la base es PAQ, este precio ya es el del paquete.' },
  { id: 'mayoreo_unidad', label: 'Mayoreo unidad', grupo: 'precio', num: true, ayuda: 'Precio por unidad al llevar el mínimo, con su umbral.' },
  { id: 'paquete', label: 'Paquete', grupo: 'precio', num: true, ayuda: 'Precio del paquete completo y cuántas piezas trae.' },
  { id: 'mayoreo_paquete', label: 'Mayoreo paquete', grupo: 'precio', num: true, ayuda: 'Precio de paquete al llevar el mínimo, con su umbral.' },
  { id: 'caja', label: 'Caja', grupo: 'precio', num: true, ayuda: 'Precio de la caja completa y cuántas piezas trae.' },
  { id: 'costo', label: 'Costo', grupo: 'costo', num: true, ayuda: 'Costo base del catálogo. ⚠️ Sale del catálogo, no del precio del punto de venta (ADR-051).' },
];

/**
 * Lo que sale tildado la primera vez: la matriz de precios completa más lo mínimo para saber de
 * qué producto y de qué unidad se habla. El **costo NO** — es la cifra que no puede terminar en
 * una hoja que se le muestra al proveedor por descuido.
 */
export const COLUMNAS_DEFAULT: readonly ColumnaReporteId[] = [
  'sku', 'unidad', 'precio_unidad', 'mayoreo_unidad', 'paquete', 'mayoreo_paquete', 'caja',
];

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });

/** Dinero, o `null` si el valor no es un número usable. Postgres manda los `numeric` como texto. */
export function money(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? MXN.format(n) : null;
}

/** Entero positivo, o `null`. Un `0` de cantidad tampoco es una cantidad. */
function entero(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * Un escalón de mayoreo escrito como se lee: precio **y** desde cuántas.
 *
 * ⚠️ Cuando hay precio y NO hay umbral se dice «sin mínimo declarado» en vez de inventar un
 * «desde 3». Es la misma decisión que tomó la etiquetera: *un mayoreo cuya condición de cantidad
 * no se conoce fabrica una discusión en el mostrador*. Medido en prod: 17 productos están así.
 */
function mayoreo(precio: unknown, desde: unknown): string {
  const p = money(precio);
  if (!p) return '—';
  const n = entero(desde);
  // `desde 1` NO es un umbral: es el precio normal con otro nombre. Misma guarda que la
  // etiquetera (`tiersDeFila`), y por la misma razón — imprimirlo prometería una condición que
  // la caja no va a respetar.
  return n && n > 1 ? `${p} desde ${n}` : `${p} · sin mínimo declarado`;
}

/** Precio de un bulto (paquete o caja) con cuántas piezas trae. Sin precio, no hay celda. */
function bulto(precio: unknown, piezas: unknown): string {
  const p = money(precio);
  if (!p) return '—';
  const n = entero(piezas);
  return n ? `${p} · ${n} pz` : p;
}

/**
 * El texto de UNA celda del reporte. Es la única forma en que el reporte escribe un número.
 */
export function celdaReporte(row: PriceReportRow, id: ColumnaReporteId): string {
  switch (id) {
    case 'sku': return row.sku || '—';
    case 'barcode': return row.barcode || '—';
    case 'marca': return row.brand_name || '—';
    case 'contenido': return row.content || '—';
    case 'unidad': return row.unit_base || '—';
    case 'precio_unidad': return money(row.piece_price) ?? '—';
    case 'mayoreo_unidad': return mayoreo(row.wholesale_piece_price, row.wholesale_piece_min_qty);
    case 'paquete': return bulto(row.pack_price, row.pack_size);
    case 'mayoreo_paquete': return mayoreo(row.wholesale_pack_price, row.wholesale_pack_min_qty);
    case 'caja': return bulto(row.box_price, row.box_size);
    case 'costo': return money(row.cost_base) ?? '—';
    default: return '—';
  }
}

/** Las columnas elegidas, siempre en el orden del catálogo (no en el orden en que se tildaron). */
export function columnasElegidas(elegidas: readonly ColumnaReporteId[]): ColumnaReporte[] {
  const set = new Set(elegidas);
  return COLUMNAS_REPORTE.filter((c) => set.has(c.id));
}
