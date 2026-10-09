/**
 * `[NP.2]` Productos nuevos — la lógica pura: junta la historia (matvista) con lo de hoy (ODS en
 * vivo) y la existencia, y de ahí saca etapa, hitos 30/60/90, tendencia, plazas agotadas y la
 * RECOMENDACIÓN de recompra, global y por sucursal.
 *
 * Vive aparte del servicio para poder probarse sin base. Toda regla tiene UNA implementación, aquí.
 *
 * Reglas que no se negocian (ADR-056):
 *   · Lo que no se pudo medir va NULL, nunca 0. Una inversión NULL es "no medida" (el producto
 *     entró por el CEDIS cuando era Wincaja, o por traspaso), no "no costó nada".
 *   · Un hito que todavía no llega no es un hito cerrado: se publica marcado como EN CURSO.
 *   · "Venta por cada peso invertido" sólo se calcula sobre productos con inversión medida, y en
 *     la cohorte sobre el MISMO universo en el numerador y en el denominador.
 *   · La recomendación es del SISTEMA y se dice con sus motivos; la decide Compras. Mide
 *     ROTACIÓN y RECUPERACIÓN de lo invertido, no margen: el costo de lo vendido todavía no se
 *     puede medir bien para un producto nuevo (ADR-051).
 */

export const NEW_PRODUCT_KINDS = ['nuevo', 'recodificacion', 'promocion', 'no_mercancia'] as const;
export type NewProductKind = (typeof NEW_PRODUCT_KINDS)[number];

/** Las tres clasificaciones que sacan al producto de los KPIs: no son lanzamientos. */
const KINDS_FUERA: ReadonlySet<NewProductKind> = new Set(['recodificacion', 'promocion', 'no_mercancia']);

export const HITOS = [30, 60, 90] as const;
export type Hito = (typeof HITOS)[number];

/**
 * El criterio de la recomendación. Es una PROPUESTA para calibrar con Compras, no una verdad: por
 * eso vive en un solo lugar, con nombre, y la pantalla lo muestra en "Cómo se decide".
 */
export const CRITERIO_RECOMPRA = {
  /** Antes de este día no se recomienda nada: hay muy poca venta para juzgar. */
  diasMinimos: 21,
  /** La ventana de "venta reciente". */
  ventana: 28,
  /** Días con venta, dentro de la ventana, para decir que se vende de forma sostenida (2 por semana). */
  diasConVentaSano: 8,
  /** Si la venta de la ventana cae por debajo de esta fracción de la ventana anterior, se revisa. */
  caidaMaxima: 0.6,
  /** Pesos vendidos por cada peso invertido (a precio de venta) para decir que ya se recuperó. */
  recuperadoAlto: 0.8,
  /** Días seguidos sin venta para decir que dejó de venderse. */
  sinVentaDias: 21,
} as const;

/** En qué tramo de su seguimiento va. `sin_movimiento` = dado de alta, sin entrada ni venta. */
export type Etapa = 'sin_movimiento' | 'mes_1' | 'mes_2' | 'mes_3' | 'graduado';

/**
 * Si cuenta para los KPIs, y si no, por qué. Es lo que separa "nuevo" de "código nuevo".
 *   seguimiento    — lanzamiento real (o por confirmar): entra a los KPIs y tiene recomendación.
 *   sin_movimiento — dado de alta y todavía sin entrada ni venta.
 *   no_medible     — no hay 90 días de historia antes de su primera actividad.
 *   excluido       — promoción, descuento, descontinuado, o Compras dijo que no es lanzamiento.
 */
export type Estado = 'seguimiento' | 'sin_movimiento' | 'no_medible' | 'excluido';

export type Veredicto = 'recomprar' | 'esperar' | 'revisar' | 'no_recomprar' | 'pronto';

export interface Recomendacion {
  veredicto: Veredicto;
  /** Por qué, en palabras. El primero es el principal. */
  motivos: string[];
}

/**
 * Cantidad por rótulo de Kepler, tal como lo declara el renglón: `{ CJA: 3, PZA: 40 }`. Cada
 * rótulo va por su lado: cajas y piezas no se suman (la unidad es de la celda, UNIDADES §8nonies).
 * `?` = renglones que no declaran unidad.
 */
export type Unidades = Record<string, number>;

/** Una fila tal como sale de la matvista, con la clasificación de Compras unida. */
export interface NewProductSource {
  product_id: string;
  sku: string;
  nombre: string | null;
  marca: string | null;
  proveedor: string | null;
  alta_suite: string;
  alta_en_lote: boolean;
  primera_recepcion: string | null;
  primera_venta: string | null;
  lanzamiento: string | null;
  historia_desde: string | null;
  fuentes: string[];
  sin_movimiento: boolean;
  no_medible: boolean;
  exclusion_auto: string | null;
  posible_recodificacion: boolean;
  /** Primer día que NO está en la historia (lo de este día en adelante viene en vivo). */
  corte: string;
  /** Venta en pesos de cada día, del lanzamiento a `corte - 1`. */
  venta_dia: Array<number | string>;
  venta_por_plaza: Record<string, Array<number | string>>;
  /** Venta de TIENDA KEPLER en sus unidades, por plaza; `i` = los pesos que cubren esas unidades. */
  venta_unidades?: Record<string, { u: Record<string, number | string>; i: number | string }>;
  entradas: Array<{ f: string; p: string; folio?: string; i: number | string; u?: Record<string, number | string> }>;
  /** `[NP.15]` Por plaza, lo que hace falta para los márgenes (historia, pesos SIN impuesto). */
  margen_plaza?: Record<string, MargenFuente>;
  /** `[NP.15]` Lo comprado en UNIDAD BASE: `{ rótulo: { q: cantidad, i: importe sin impuesto } }`. */
  compra_base?: Record<string, { q: number | string; i: number | string }>;
  /**
   * `[NP.16]` El barrido del kardex: primera compra física (`X-A-40`) y dónde, y la primera entrada
   * de cualquier tipo. `{}` = el producto no tiene kardex en ningún almacén principal.
   */
  llegada?: { compra?: string | null; compra_plazas?: string[] | null; entrada?: string | null; entrada_doc?: string | null } | null;
  /** `[NP.16]` Unidades vendidas en los primeros 30/60/90 días: `{ "30": { CJA: 3 } }`. */
  venta_unidades_hito?: Record<string, Record<string, number | string>>;
  /**
   * `[NP.16]` Por plaza, lo recibido de otra sucursal y lo mandado a otras y a rutas, por rótulo; y
   * `desde` = el primer día que le llegó por traspaso.
   */
  reparto?: Record<string, Partial<Record<TipoReparto, Record<string, number | string>>> & { desde?: string }>;
  clasificacion: NewProductKind | null;
  nota: string | null;
  clasificado_por: string | null;
}

/**
 * `[NP.15]` Lo que la matvista deja por plaza para los márgenes. Todo en pesos SIN IVA/IEPS y sobre
 * la HISTORIA (del lanzamiento a la víspera del corte): lo de hoy no entra en los márgenes.
 */
export interface MargenFuente {
  /** Venta neta. */
  n: number | string;
  /** La parte de la venta neta que trae el costo del renglón (`kdm2.c62`). */
  nc: number | string;
  /** El costo de esa venta. */
  c: number | string;
  /** La parte de la venta neta cuya ficha trae % de margen para el peldaño vendido. */
  nm: number | string;
  /** Los pesos de margen que daría la meta de la ficha sobre esa venta. */
  m: number | string;
  /** Lo vendido en unidad base: `{ rótulo: { q: cantidad, n: venta neta } }`. */
  b?: Record<string, { q: number | string; n: number | string }>;
}

/**
 * Un margen, con lo que alcanza a cubrir. `pct` sobre la venta neta que cubre; NULL = no se pudo
 * medir, y `nota` dice por qué. Nunca se dibuja un cero donde no hubo con qué medir (ADR-056).
 */
export interface Margen {
  pct: number | null;
  /** Pesos de margen sobre la venta que cubre. */
  utilidad: number | null;
  /** Qué parte de la venta neta cubre (0 a 1). */
  cobertura: number | null;
  /** Por qué no se midió, o qué parte queda fuera. */
  nota: string | null;
}

/** `[NP.15]` Los tres márgenes de un producto (o de una plaza). */
export interface Margenes {
  /** Venta sin IVA/IEPS de la historia: el denominador de los tres. */
  venta_neta: number;
  /** ¿Con qué margen lo pusimos a la venta? La meta de la ficha, por el peldaño vendido. */
  lista: Margen;
  /** ¿Cuánto dejó? Con el costo que Kepler escribió en cada renglón vendido. */
  real: Margen;
  /** ¿La ficha tiene el costo correcto? Con lo que se pagó en sus compras. */
  pagado: Margen;
  /** Lo pagado por unidad base en sus compras: la base del margen sobre lo pagado. */
  costo_pagado: { unidad: string; por_unidad: number } | null;
}

/** `[NP.15]` Qué tan bien se mueve en una plaza. */
export interface Movilidad {
  /** Venta sin impuesto por día, desde su primera actividad en la plaza hasta la víspera del corte. */
  venta_neta_dia: number | null;
  /** Días de historia en la plaza (los que entran en `venta_neta_dia`). */
  dias: number | null;
  /** De lo que pasó por la plaza (vendido + existencia de hoy), qué parte se vendió. En unidad base. */
  desplazado: number | null;
  /** Lugar entre las plazas (1 = la que mejor se mueve). NULL = todavía no compite. */
  lugar: number | null;
}

export interface MejorPlaza {
  plaza: string;
  nombre: string | null;
  venta_neta_dia: number;
  dias: number;
}

/**
 * Para comparar plazas. Una plaza con pocos días puede verse enorme por una sola venta: hasta
 * `diasMinimos` de historia en la plaza no entra al ranking.
 */
export const CRITERIO_SUCURSAL = {
  diasMinimos: 7,
} as const;

/**
 * `[NP.16]` Los movimientos que no son venta ni compra: lo que una sucursal recibe de otra (`U-A-50`)
 * y lo que manda a otra sucursal o a un camión de ruta (`U-D-41`). La remisión a un cliente de
 * telemarketing no está aquí: se factura después como `U-D-8` y ya cuenta como venta.
 */
export type TipoReparto = 'traspaso' | 'salida_sucursal' | 'salida_ruta';
export const TIPOS_REPARTO: readonly TipoReparto[] = ['traspaso', 'salida_sucursal', 'salida_ruta'];

/** Lo que pasó desde el corte (ODS en vivo). */
export interface Movimiento {
  product_id: string;
  tipo: 'venta' | 'entrada' | TipoReparto;
  plaza: string;
  fecha: string;
  folio?: string | null;
  /** El rótulo que declara el renglón de Kepler (`c55` si su identidad cierra; si no, `c11`). */
  unidad?: string | null;
  cantidad?: number | string | null;
  importe: number | string;
}

/** Existencia de hoy, por plaza, en la unidad de inventario de esa plaza. */
export interface Existencia {
  product_id: string;
  plaza: string;
  cantidad: number | string;
  /** Divisor de presentación de esa plaza (ADR-055). Sólo se usa para Wincaja. */
  factor: number | string | null;
  /** `kepler` | `wincaja`: de qué ERP sale la existencia, y por tanto en qué unidad viene. */
  fuente?: string | null;
  /** Rótulo base de la ficha de Kepler de ESA plaza (`kdii.c11`): Kepler guarda el inventario en él. */
  unidad?: string | null;
  /** El peldaño mayor de esa misma ficha y su factor (en unidades base). */
  unidad_mayor?: string | null;
  factor_mayor?: number | string | null;
  /** `[NP.16]` El peldaño intermedio de la ficha (`kdii` u2) y su factor, y en qué peldaño está la caja. */
  unidad_media?: string | null;
  factor_media?: number | string | null;
  peldano_caja?: number | string | null;
}

/** Una cantidad en una unidad de la ficha. */
export interface CantidadEnUnidad {
  unidad: string;
  cantidad: number;
}

export interface HitoValores {
  /** El día del hito ya pasó: la cifra es definitiva. `false` = va en curso. */
  cerrado: boolean;
  inversion: number | null;
  venta: number | null;
  /** `[NP.16]` Lo vendido en tienda Kepler en ese tramo, en las unidades en que se vendió. */
  unidades: Unidades;
}

/**
 * `[NP.16]` Cuándo llegó el producto a la empresa, del barrido del kardex de Kepler. La compra física
 * es la orden de entrada (`X-A-40`): ahí entra el inventario, días antes de que se aplique la compra.
 */
export interface Llegada {
  /** La primera compra física, en cualquier sucursal. NULL = no hay compra en Kepler. */
  fecha: string | null;
  /** En qué sucursales entró ese primer día. */
  sucursales: Array<{ plaza: string; nombre: string | null }>;
  /** `kardex` = del barrido; `compra_aplicada` = el kardex no trae nada y se usa la compra aplicada. */
  fuente: 'kardex' | 'compra_aplicada';
  /** Si entró ANTES por otro camino (o sin compra), cuándo y por qué documento. */
  antes: { fecha: string; tipo: string } | null;
}

/** El documento de Kepler en palabras. Uno que no está decodificado se dice con su clave. */
const TIPO_ENTRADA: Record<string, string> = {
  'X-A-40': 'compra',
  'U-A-50': 'traspaso de otra sucursal',
  'N-A-30': 'ajuste de inventario',
};
export const tipoEntradaTexto = (doc: string): string => TIPO_ENTRADA[doc] ?? `otro movimiento (${doc})`;

/** Las señales que alimentan la recomendación (global o de una plaza). */
export interface Senales {
  dia: number | null;
  venta_total: number;
  inversion_total: number | null;
  dias_con_venta_28: number;
  venta_28: number;
  /** Venta de las 4 semanas anteriores; NULL si el producto todavía no las vivió. */
  venta_28_previa: number | null;
  /** Días desde la última venta; NULL si nunca se vendió. */
  dias_sin_venta: number | null;
  /** Plazas que lo vendieron en la ventana y hoy no tienen existencia. */
  agotado_en: number;
  plazas_con_existencia: number;
}

export interface NewProductRow {
  product_id: string;
  sku: string;
  nombre: string | null;
  marca: string | null;
  proveedor: string | null;
  alta_suite: string;
  alta_en_lote: boolean;
  primera_recepcion: string | null;
  primera_venta: string | null;
  lanzamiento: string | null;
  dia: number | null;
  fuentes: string[];
  etapa: Etapa;
  estado: Estado;
  /** Por qué está excluido o no se mide. NULL si está en seguimiento. */
  motivo: string | null;
  posible_recodificacion: boolean;
  clasificacion: NewProductKind | null;
  nota: string | null;
  clasificado_por: string | null;
  hitos: Record<Hito, HitoValores>;
  inversion_total: number | null;
  venta_total: number | null;
  /** Venta acumulada por cada peso invertido. NULL si la inversión no se midió. */
  venta_por_peso: number | null;
  entradas: number;
  plazas_recibido: number;
  primera_recompra: string | null;
  /** A cuántos días de su lanzamiento se volvió a comprar. */
  dia_recompra: number | null;
  plazas_venta: number;
  plazas_con_existencia: number;
  /** Plazas que lo vendieron en las últimas 4 semanas y hoy no tienen existencia. */
  agotado_en: number;
  dias_con_venta_30: number;
  dias_con_venta_28: number;
  venta_28: number;
  /** Venta 4 semanas contra las 4 anteriores (1 = igual). NULL si no hay 8 semanas. */
  tendencia: number | null;
  ultima_venta: string | null;
  /** Ya cumplió 30 días y no vendió nada en ellos. */
  sin_venta_30: boolean;
  /** Venta por semana desde el lanzamiento; la última puede ir incompleta. */
  semanas: number[];
  /** Venta de HOY (en vivo). */
  venta_hoy: number;
  /** Lo vendido en tienda Kepler, en las unidades en que se vendió (historia + hoy). */
  unidades_vendidas: Unidades;
  /** Pesos vendidos SIN unidad de Kepler (ruta y plazas en Wincaja). 0 = toda la venta la trae. */
  venta_sin_unidad: number;
  /** Lo recibido (entradas de Kepler), en las unidades en que entró. */
  unidades_recibidas: Unidades;
  unidades_hoy: Unidades;
  recomendacion: Recomendacion | null;
  /** `[NP.15]` NULL = sin venta en la historia, o sin permiso de costo. */
  margenes: Margenes | null;
  /** `[NP.15]` La plaza donde mejor se mueve (venta neta por día). NULL = ninguna compite todavía. */
  mejor_plaza: MejorPlaza | null;
  /** `[NP.16]` Cuándo llegó a la empresa. NULL = no hay compra ni entrada con qué fecharlo. */
  llegada: Llegada | null;
}

export interface PlazaRow {
  plaza: string;
  nombre: string | null;
  /** Día desde la primera actividad EN ESTA plaza. */
  dia: number | null;
  primera_actividad: string | null;
  venta_total: number;
  venta_28: number;
  dias_con_venta_28: number;
  inversion_total: number | null;
  entradas: number;
  primera_recompra: string | null;
  /** Existencia de hoy en la unidad de inventario de la plaza; NULL = no hay renglón de existencia. */
  existencia: number | null;
  /** El rótulo de esa existencia según la ficha de Kepler de la plaza. NULL = no se sabe (se declara). */
  existencia_unidad: string | null;
  /** `kepler` | `wincaja` | NULL. */
  existencia_fuente: string | null;
  /**
   * `[NP.16]` La misma existencia en las presentaciones de la ficha de la plaza, de la mayor a la base y
   * en enteros: 334 piezas = 5 cajas, 3 paquetes y 4 piezas. NULL si la ficha no declara una caja con
   * su factor, o si no alcanza para una presentación mayor (no diría nada nuevo).
   */
  existencia_desglose: CantidadEnUnidad[] | null;
  unidades_vendidas: Unidades;
  venta_sin_unidad: number;
  unidades_recibidas: Unidades;
  /** `[NP.16]` Lo que le llegó de otra sucursal (`U-A-50`), en las unidades en que llegó. */
  recibido_traspaso: Unidades;
  /** `[NP.16]` Lo que mandó a otras sucursales (`U-D-41` a `TI###`). */
  enviado_sucursales: Unidades;
  /** `[NP.16]` Lo que mandó a camiones de ruta (`U-D-41` a `RUTA`/`RD`). */
  enviado_rutas: Unidades;
  unidades_hoy: Unidades;
  ultima_venta: string | null;
  /** Venta por semana de las últimas 8 semanas (la última puede ir incompleta). */
  semanas: number[];
  venta_hoy: number;
  recomendacion: Recomendacion;
  /** `[NP.15]` NULL = sin venta en la historia de la plaza, o sin permiso de costo. */
  margenes: Margenes | null;
  movimiento: Movilidad;
}

export interface Cohorte {
  /** `YYYY-MM` del lanzamiento. */
  mes: string;
  productos: number;
  /** Cuántos de esos tienen inversión medida: el universo del cociente. */
  con_inversion: number;
  inversion: number | null;
  venta: number;
  venta_por_peso: number | null;
  recomprados: number;
  /** Los que ya cumplieron 30 días: el denominador de `sin_venta_30`. */
  con_30_dias: number;
  sin_venta_30: number;
}

export interface Resumen {
  total: number;
  seguimiento: number;
  por_confirmar: number;
  sin_movimiento: number;
  no_medible: number;
  excluido: number;
  por_etapa: Record<Exclude<Etapa, 'sin_movimiento'>, number>;
  por_veredicto: Record<Veredicto, number>;
  inversion: number | null;
  venta: number;
  venta_hoy: number;
  venta_por_peso: number | null;
  recomprados: number;
  con_30_dias: number;
  sin_venta_30: number;
}

const ETIQUETA_EXCLUSION: Record<string, string> = {
  promocion: 'Promoción',
  descuento: 'Código de descuento',
  descontinuado: 'Descontinuado',
  recodificacion: 'Recodificación (Compras)',
  no_mercancia: 'No es mercancía (Compras)',
};

// ─────────────────────────────── utilidades ───────────────────────────────

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r2 = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);

/** Suma rótulo por rótulo (nunca entre rótulos distintos). */
function sumarUnidades(dst: Unidades, src: Record<string, number | string> | null | undefined): Unidades {
  for (const [u, q] of Object.entries(src ?? {})) {
    const n = num(q);
    if (n !== null) dst[u] = (dst[u] ?? 0) + n;
  }
  return dst;
}
/** Quita los rótulos que suman cero (una venta y su devolución) y redondea. */
function limpiarUnidades(u: Unidades): Unidades {
  return Object.fromEntries(Object.entries(u)
    .filter(([, q]) => Math.abs(q) >= 0.0005)
    .map(([k, q]) => [k, Math.round(q * 1000) / 1000]));
}
/** Las unidades de un movimiento en vivo, como el mismo objeto `{ rótulo: cantidad }`. */
const unidadesDe = (m: Movimiento): Record<string, number | string> =>
  (m.cantidad === null || m.cantidad === undefined ? {} : { [m.unidad || '?']: m.cantidad });
/** Pesos sin unidad: lo vendido menos lo que trae unidad. Diferencias de centavos no cuentan. */
const sinUnidad = (total: number, cubierto: number) => {
  const d = Math.round((total - cubierto) * 100) / 100;
  return d >= 1 ? d : 0;
};

/**
 * `[NP.16]` La existencia partida en las presentaciones de la ficha de ESA plaza (`kdii`), de la mayor a
 * la base, en enteros: con caja de 60 y paquete de 10, 334 piezas son 5 cajas, 3 paquetes y 4 piezas.
 * Nunca de otra plaza ni de un catálogo, y sin factor > 1 no se inventa la caja.
 * - El intermedio entra sólo si la caja es múltiplo exacto de él (medido 2026-10-09: hay una caja de 200
 *   con paquete de 11; ahí se dice en cajas y piezas).
 * - Un bulto de peso puede tener factor fraccionario (6.84 kg): las cajas van enteras y el resto en la
 *   base, con sus decimales.
 * - Wincaja: el divisor de presentación (ADR-055) es la caja, y su base no tiene rótulo de Kepler.
 */
export function existenciaDesglose(e: Existencia | undefined): CantidadEnUnidad[] | null {
  if (!e) return null;
  const cant = num(e.cantidad) ?? 0;
  if (cant <= 0) return null;
  const wincaja = e.fuente === 'wincaja';
  const fCaja = num(wincaja ? e.factor : e.factor_mayor);
  const caja = wincaja ? 'CJA' : (e.unidad_mayor ?? '').trim().toUpperCase();
  const base = wincaja ? '?' : (e.unidad ?? '').trim().toUpperCase();
  if (!caja || fCaja === null || fCaja <= 1 || caja === base) return null;
  const peldanos: Array<{ unidad: string; factor: number }> = [{ unidad: caja, factor: fCaja }];
  const media = (e.unidad_media ?? '').trim().toUpperCase();
  const fMedia = num(e.factor_media);
  if (!wincaja && Number(e.peldano_caja) === 3 && media && media !== base && media !== caja
    && fMedia !== null && fMedia > 1 && fMedia < fCaja && Number.isInteger(fMedia) && Number.isInteger(fCaja / fMedia)) {
    peldanos.push({ unidad: media, factor: fMedia });
  }
  const out: CantidadEnUnidad[] = [];
  let resto = cant;
  for (const p of peldanos) {
    // El épsilon evita que 59.999999 cuente como 0 cajas por el redondeo del flotante.
    const n = Math.floor(resto / p.factor + 1e-9);
    if (n > 0) out.push({ unidad: p.unidad, cantidad: n });
    resto = Math.round((resto - n * p.factor) * 1000) / 1000;
  }
  if (resto > 0) out.push({ unidad: base || '?', cantidad: resto });
  // Si no alcanzó ni para la presentación mayor, el desglose sería la misma cifra de la base.
  return out.length && out[0].unidad !== (base || '?') ? out : null;
}
const pesos = (v: number) => `$${Math.round(v).toLocaleString('es-MX')}`;

const DIA_MS = 86_400_000;
const aMs = (f: string) => Date.parse(`${f.slice(0, 10)}T00:00:00Z`);
export function diasEntre(desde: string | null, hasta: string | null): number | null {
  if (!desde || !hasta) return null;
  const a = aMs(desde);
  const b = aMs(hasta);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DIA_MS) : null;
}
export function sumarDias(f: string, n: number): string {
  return new Date(aMs(f) + n * DIA_MS).toISOString().slice(0, 10);
}

export function etapaDe(dia: number | null): Etapa {
  if (dia === null || dia === undefined) return 'sin_movimiento';
  if (dia < 30) return 'mes_1';
  if (dia < 60) return 'mes_2';
  if (dia < 90) return 'mes_3';
  return 'graduado';
}

/**
 * La decisión de Compras manda sobre la del sistema: si alguien dijo "es nuevo" de un código que
 * el sistema creyó promoción, cuenta. Si dijo recodificación, sale aunque el sistema no lo viera.
 */
export function estadoDe(f: Pick<NewProductSource,
  'clasificacion' | 'exclusion_auto' | 'sin_movimiento' | 'no_medible'>): { estado: Estado; motivo: string | null } {
  if (f.clasificacion && KINDS_FUERA.has(f.clasificacion)) {
    return { estado: 'excluido', motivo: ETIQUETA_EXCLUSION[f.clasificacion] ?? f.clasificacion };
  }
  if (f.exclusion_auto && f.clasificacion !== 'nuevo') {
    return { estado: 'excluido', motivo: ETIQUETA_EXCLUSION[f.exclusion_auto] ?? f.exclusion_auto };
  }
  if (f.sin_movimiento) return { estado: 'sin_movimiento', motivo: 'Dado de alta, sin entrada ni venta' };
  if (f.no_medible) {
    return {
      estado: 'no_medible',
      motivo: 'Sólo se ha movido en sucursales con menos de 90 días en Kepler: no se puede afirmar que antes no se vendía',
    };
  }
  return { estado: 'seguimiento', motivo: null };
}

/**
 * La serie DIARIA del lanzamiento a hoy: la historia de la matvista y, desde el corte, lo de hoy.
 * `historia` arranca en `lanzamiento`; los días de `vivo` se colocan por fecha.
 */
export function serieDiaria(
  lanzamiento: string, hoy: string, corte: string,
  historia: Array<number | string>, vivo: Array<{ fecha: string; importe: number | string }>,
): number[] {
  const largo = (diasEntre(lanzamiento, hoy) ?? -1) + 1;
  if (largo <= 0) return [];
  const s = new Array<number>(largo).fill(0);
  const hastaHistoria = Math.min(largo, Math.max(0, diasEntre(lanzamiento, corte) ?? 0));
  for (let i = 0; i < hastaHistoria && i < historia.length; i += 1) s[i] = num(historia[i]) ?? 0;
  for (const m of vivo) {
    const i = diasEntre(lanzamiento, m.fecha);
    if (i !== null && i >= 0 && i < largo) s[i] += num(m.importe) ?? 0;
  }
  return s.map((x) => Math.round(x * 100) / 100);
}

/** Venta por semana (bloques de 7 días desde el inicio de la serie). */
export function porSemana(serie: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < serie.length; i += 7) {
    out.push(Math.round(serie.slice(i, i + 7).reduce((a, b) => a + b, 0) * 100) / 100);
  }
  return out;
}

interface Ventana { venta: number; dias: number; previa: number | null; ultima: number | null }
/** Venta y días con venta de las últimas `n` posiciones, la ventana previa y el último día con venta. */
function ventana(serie: number[], n: number): Ventana {
  const ult = serie.slice(-n);
  const prev = serie.length >= 2 * n ? serie.slice(-2 * n, -n) : null;
  let ultima: number | null = null;
  for (let i = serie.length - 1; i >= 0; i -= 1) if (serie[i] > 0) { ultima = serie.length - 1 - i; break; }
  return {
    venta: ult.reduce((a, b) => a + b, 0),
    dias: ult.filter((x) => x > 0).length,
    previa: prev ? prev.reduce((a, b) => a + b, 0) : null,
    ultima,
  };
}

/** Recompra = segunda FECHA de entrada en una plaza que ya lo había recibido. */
function primeraRecompra(entradas: Array<{ f: string; p: string }>): string | null {
  const porPlaza = new Map<string, Set<string>>();
  for (const e of entradas) {
    const s = porPlaza.get(e.p) ?? new Set<string>();
    s.add(e.f.slice(0, 10));
    porPlaza.set(e.p, s);
  }
  let min: string | null = null;
  for (const fechas of porPlaza.values()) {
    const segunda = [...fechas].sort()[1];
    if (segunda && (min === null || segunda < min)) min = segunda;
  }
  return min;
}

// ─────────────────────────────── la recomendación ───────────────────────────────

/**
 * ¿Conviene volver a comprarlo? Determinista y explicable: cada veredicto sale con sus motivos.
 * `conCosto = false` no cambia la decisión, sólo calla las cifras de inversión en los motivos.
 */
export function recomendar(s: Senales, opts: { conCosto: boolean } = { conCosto: true }): Recomendacion {
  const C = CRITERIO_RECOMPRA;
  const dia = s.dia ?? 0;
  const recuperado = s.inversion_total !== null && s.inversion_total > 0 ? s.venta_total / s.inversion_total : null;
  const sostenida = `Se vendió ${s.dias_con_venta_28} de los últimos ${C.ventana} días`;

  if (s.dia === null) return { veredicto: 'pronto', motivos: ['Todavía no entra ni se vende'] };
  if (dia < C.diasMinimos) {
    return {
      veredicto: 'pronto',
      motivos: [`Lleva ${dia} día${dia === 1 ? '' : 's'}; se decide a partir del día ${C.diasMinimos}`,
        s.venta_total > 0 ? `Ya vendió ${pesos(s.venta_total)}` : 'Todavía no se vende'],
    };
  }
  if (s.venta_total <= 0) {
    return { veredicto: 'no_recomprar', motivos: [`No se ha vendido en ${dia} días desde que llegó`] };
  }
  if (s.dias_sin_venta !== null && s.dias_sin_venta >= C.sinVentaDias) {
    return { veredicto: 'no_recomprar', motivos: [`Lleva ${s.dias_sin_venta} días sin venderse`] };
  }
  if (s.venta_28_previa !== null && s.venta_28_previa > 0 && s.venta_28 / s.venta_28_previa < C.caidaMaxima) {
    const caida = Math.round((1 - s.venta_28 / s.venta_28_previa) * 100);
    return {
      veredicto: 'revisar',
      motivos: [`La venta de las últimas 4 semanas cayó ${caida}% contra las 4 anteriores`, sostenida],
    };
  }
  if (s.dias_con_venta_28 < C.diasConVentaSano) {
    return { veredicto: 'revisar', motivos: [`Se vende poco: ${s.dias_con_venta_28} de los últimos ${C.ventana} días`] };
  }

  const motivos = [sostenida];
  const agotado = s.agotado_en > 0;
  const sinExistencia = s.plazas_con_existencia === 0;
  const recuperadoAlto = recuperado !== null && recuperado >= C.recuperadoAlto;
  if (agotado) motivos.push(`Se agotó en ${s.agotado_en} plaza${s.agotado_en === 1 ? '' : 's'} que lo vende${s.agotado_en === 1 ? '' : 'n'}`);
  else if (sinExistencia) motivos.push('Ya no hay existencia en ninguna plaza');
  if (recuperado !== null) {
    motivos.push(opts.conCosto
      ? `Vendió $${recuperado.toFixed(2)} por cada $1 invertido`
      : (recuperadoAlto ? 'Ya vendió la mayor parte de lo que se compró' : 'Todavía no vende lo que se compró'));
  }
  if (agotado || sinExistencia || recuperadoAlto) return { veredicto: 'recomprar', motivos };
  return {
    veredicto: 'esperar',
    motivos: ['Se vende bien, pero todavía hay existencia', ...motivos],
  };
}

// ─────────────────────────────── los márgenes (NP.15) ───────────────────────────────

const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** Una cobertura que no llega a esto se dice: la diferencia ya no es de redondeo. */
const COBERTURA_COMPLETA = 0.995;
const pctTexto = (v: number) => `${Math.round(v * 100)}%`;
const sinMedir = (nota: string): Margen => ({ pct: null, utilidad: null, cobertura: 0, nota });
const margenSobre = (venta: number, ganancia: number, total: number): Pick<Margen, 'pct' | 'utilidad' | 'cobertura'> => ({
  pct: Math.round((ganancia / venta) * 1000) / 10,
  utilidad: r2(ganancia),
  cobertura: r3(venta / total),
});

/**
 * Los tres márgenes, sumando las plazas que se le pasen (una sola = el margen de esa plaza). `compra`
 * es la del PRODUCTO: lo pagado por unidad base no depende de la plaza donde se vendió.
 *
 *   · De lista — `m / nm`: la meta de la ficha ponderada por la venta de cada peldaño vendido.
 *   · Real     — `(nc − c) / nc`: con el costo que Kepler escribió en el renglón.
 *   · Pagado   — lo vendido en la MISMA unidad base que la compra, contra lo que costó esa unidad.
 *
 * El denominador de cada uno es SÓLO la venta que puede juzgar; lo demás va a la cobertura y a la
 * nota. Promediar con cero la venta que no trae costo diría que se regaló (ADR-056).
 */
export function margenesDe(
  fuentes: MargenFuente[],
  compra: Record<string, { q: number | string; i: number | string }> | undefined,
): Margenes | null {
  let n = 0, nc = 0, c = 0, nm = 0, m = 0;
  const base = new Map<string, { q: number; n: number }>();
  for (const f of fuentes) {
    n += num(f.n) ?? 0;
    nc += num(f.nc) ?? 0;
    c += num(f.c) ?? 0;
    nm += num(f.nm) ?? 0;
    m += num(f.m) ?? 0;
    for (const [u, x] of Object.entries(f.b ?? {})) {
      const acc = base.get(u) ?? { q: 0, n: 0 };
      acc.q += num(x.q) ?? 0;
      acc.n += num(x.n) ?? 0;
      base.set(u, acc);
    }
  }
  if (n <= 0) return null;

  const lista: Margen = nm > 0
    ? { ...margenSobre(nm, m, n),
        nota: nm / n < COBERTURA_COMPLETA
          ? `La ficha de Kepler no trae % de margen para el ${pctTexto(1 - nm / n)} de lo vendido`
          : null }
    : sinMedir('La ficha de Kepler no trae % de margen para lo que se vendió');

  const real: Margen = nc > 0
    ? { ...margenSobre(nc, nc - c, n),
        nota: nc / n < COBERTURA_COMPLETA
          ? `Kepler no registró el costo en el ${pctTexto(1 - nc / n)} de la venta (suele ser venta de mayoreo)`
          : null }
    : sinMedir('Kepler no registró el costo en ninguna venta de este producto');

  // Lo pagado: un costo por unidad base, de las compras que traen cantidad e importe.
  const compras = Object.entries(compra ?? {})
    .map(([u, x]) => ({ u, q: num(x.q) ?? 0, i: num(x.i) ?? 0 }))
    .filter((x) => x.q > 0 && x.i > 0);
  let pagado: Margen;
  let costoPagado: Margenes['costo_pagado'] = null;
  if (!compras.length) {
    pagado = sinMedir('Sin compras en Kepler dentro de su historia: llegó por traspaso o antes de los 180 días');
  } else if (compras.length > 1) {
    pagado = sinMedir(`La compra viene en varias unidades base (${compras.map((x) => x.u).join(', ')}): no hay un solo costo por unidad`);
  } else {
    const { u, q, i } = compras[0];
    const porUnidad = i / q;
    costoPagado = { unidad: u, por_unidad: Math.round(porUnidad * 10_000) / 10_000 };
    const vend = base.get(u);
    if (!vend || vend.n <= 0) {
      const otras = [...base.keys()].filter((x) => x !== u);
      pagado = sinMedir(otras.length
        ? `La compra viene en ${u} y la venta en ${otras.join(', ')}: Kepler no las declara en la misma unidad`
        : 'Sin venta en la unidad de la compra');
    } else {
      pagado = {
        ...margenSobre(vend.n, vend.n - vend.q * porUnidad, n),
        nota: vend.n / n < COBERTURA_COMPLETA
          ? `El ${pctTexto(1 - vend.n / n)} de la venta viene en otra unidad base y no se compara`
          : null,
      };
    }
  }
  return { venta_neta: r2(n) ?? 0, lista, real, pagado, costo_pagado: costoPagado };
}

// ─────────────────────────────── armado por producto ───────────────────────────────

export interface Armado {
  fila: NewProductRow;
  plazas: PlazaRow[];
}

/**
 * Junta la historia, lo de hoy y la existencia de UN producto.
 * `nombres` = código de plaza → nombre (sólo para el detalle).
 */
export function armarProducto(
  f: NewProductSource, hoy: string, vivo: Movimiento[], existencia: Existencia[],
  opts: { conCosto: boolean; nombres?: Map<string, string> } = { conCosto: true },
): Armado {
  const nombres = opts.nombres ?? new Map<string, string>();
  const ventasVivo = vivo.filter((m) => m.tipo === 'venta');
  const entradasVivo = vivo.filter((m) => m.tipo === 'entrada');
  const todasEntradas = [
    ...(Array.isArray(f.entradas) ? f.entradas : []).map((e) => ({ f: e.f, p: e.p, i: num(e.i) ?? 0, u: e.u ?? {} })),
    ...entradasVivo.map((m) => ({ f: m.fecha, p: m.plaza, i: num(m.importe) ?? 0, u: unidadesDe(m) })),
  ];
  const ventaUnidades = f.venta_unidades ?? {};

  // [NP.16] Traspasos recibidos y salidas a otras sucursales o rutas, de hoy.
  const repartoVivo = vivo.filter((m) => (TIPOS_REPARTO as readonly string[]).includes(m.tipo));

  // Un producto sin historia que HOY entra o se vende arranca hoy: "Nuevo · día 0". Un traspaso no
  // es lanzamiento (`[NP.16]`, igual que en la matvista): el producto ya había llegado a otra.
  const primeraViva = [...ventasVivo, ...entradasVivo].map((m) => m.fecha).sort()[0] ?? null;
  const lanzamiento = f.lanzamiento ?? primeraViva;
  const sinMovimiento = lanzamiento === null;
  const { estado, motivo } = estadoDe({
    ...f, sin_movimiento: sinMovimiento, no_medible: f.lanzamiento ? f.no_medible : false,
  });
  const dia = lanzamiento ? diasEntre(lanzamiento, hoy) : null;

  const serie = lanzamiento
    ? serieDiaria(lanzamiento, hoy, f.corte, f.venta_dia ?? [], ventasVivo.map((m) => ({ fecha: m.fecha, importe: m.importe })))
    : [];
  const v = ventana(serie, CRITERIO_RECOMPRA.ventana);

  const exPorPlaza = new Map<string, { cantidad: number; fila: Existencia }>();
  for (const e of existencia) {
    exPorPlaza.set(e.plaza, { cantidad: num(e.cantidad) ?? 0, fila: e });
  }
  const unidadesVendidas: Unidades = {};
  const unidadesRecibidas: Unidades = {};
  const unidadesHoy: Unidades = {};
  let cubierto = 0;

  // ── Por plaza ──
  const codigos = new Set<string>([
    ...Object.keys(f.venta_por_plaza ?? {}),
    ...ventasVivo.map((m) => m.plaza),
    ...todasEntradas.map((e) => e.p),
    ...[...exPorPlaza.entries()].filter(([, x]) => x.cantidad > 0).map(([p]) => p),
    // [NP.16] Una sucursal que sólo recibió por traspaso (o mandó) también es parte del reparto.
    ...Object.keys(f.reparto ?? {}),
    ...repartoVivo.map((m) => m.plaza),
  ]);
  const plazas: PlazaRow[] = [];
  let agotadoEn = 0;
  for (const p of [...codigos].sort()) {
    const serieP = lanzamiento
      ? serieDiaria(lanzamiento, hoy, f.corte, f.venta_por_plaza?.[p] ?? [],
        ventasVivo.filter((m) => m.plaza === p).map((m) => ({ fecha: m.fecha, importe: m.importe })))
      : [];
    const entradasP = todasEntradas.filter((e) => e.p === p);
    const primeraVentaIdx = serieP.findIndex((x) => x > 0);
    const primeraEntrada = entradasP.map((e) => e.f.slice(0, 10)).sort()[0] ?? null;
    const primeraVentaP = primeraVentaIdx >= 0 && lanzamiento ? sumarDias(lanzamiento, primeraVentaIdx) : null;
    // [NP.16] Lo que llegó por traspaso también cuenta como llegada a la plaza.
    const repartoP = f.reparto?.[p];
    const repartoVivoP = repartoVivo.filter((m) => m.plaza === p);
    const primerTraspaso = [repartoP?.desde ?? null, ...repartoVivoP.filter((m) => m.tipo === 'traspaso').map((m) => m.fecha)]
      .filter((x): x is string => !!x).sort()[0] ?? null;
    const primeraAct = [primeraEntrada, primeraVentaP, primerTraspaso].filter((x): x is string => !!x).sort()[0] ?? null;
    // La serie de la plaza arranca en SU primera actividad, no en la del producto.
    const desde = primeraAct && lanzamiento ? Math.max(0, diasEntre(lanzamiento, primeraAct) ?? 0) : serieP.length;
    const serieDesde = serieP.slice(desde);
    const vp = ventana(serieDesde, CRITERIO_RECOMPRA.ventana);
    const ex = exPorPlaza.get(p);
    const totalP = serieP.reduce((a, b) => a + b, 0);
    const invP = entradasP.length ? entradasP.reduce((a, e) => a + e.i, 0) : null;
    const hayExistencia = !!ex && ex.cantidad > 0;
    const agotadaAqui = vp.dias > 0 && !hayExistencia;
    if (agotadaAqui) agotadoEn += 1;
    const diaP = primeraAct ? diasEntre(primeraAct, hoy) : null;
    // Unidades de ESTA plaza: historia (matvista) + lo de hoy (en vivo). Venta y entradas aparte.
    const ventasVivoP = ventasVivo.filter((m) => m.plaza === p);
    const vendidasP: Unidades = sumarUnidades({}, ventaUnidades[p]?.u);
    for (const m of ventasVivoP) sumarUnidades(vendidasP, unidadesDe(m));
    const recibidasP: Unidades = {};
    for (const e of entradasP) sumarUnidades(recibidasP, e.u);
    const hoyP: Unidades = {};
    for (const m of ventasVivoP.filter((x) => x.fecha === hoy)) sumarUnidades(hoyP, unidadesDe(m));
    const cubiertoP = (num(ventaUnidades[p]?.i) ?? 0) + ventasVivoP.reduce((a, m) => a + (num(m.importe) ?? 0), 0);
    sumarUnidades(unidadesVendidas, vendidasP);
    sumarUnidades(unidadesRecibidas, recibidasP);
    sumarUnidades(unidadesHoy, hoyP);
    cubierto += cubiertoP;
    // [NP.15] Márgenes y movimiento de la plaza, sobre la HISTORIA (hasta la víspera del corte).
    const fuenteP = f.margen_plaza?.[p];
    const diasHist = primeraAct && primeraAct < f.corte ? diasEntre(primeraAct, f.corte) : null;
    const netaP = num(fuenteP?.n);
    const unidadEx = ex && ex.fila.fuente !== 'wincaja' ? (ex.fila.unidad ?? '').trim().toUpperCase() : '';
    const vendidoBase = unidadEx ? num(fuenteP?.b?.[unidadEx]?.q) : null;
    // [NP.16] El reparto de la plaza: historia (matvista) + lo de hoy, cada tipo por su lado.
    const repartoDe = (tipo: TipoReparto): Unidades => {
      const u = sumarUnidades({}, repartoP?.[tipo]);
      for (const m of repartoVivoP.filter((x) => x.tipo === tipo)) sumarUnidades(u, unidadesDe(m));
      return limpiarUnidades(u);
    };
    plazas.push({
      plaza: p,
      nombre: nombres.get(p) ?? null,
      dia: diaP,
      primera_actividad: primeraAct,
      venta_total: Math.round(totalP * 100) / 100,
      venta_28: Math.round(vp.venta * 100) / 100,
      dias_con_venta_28: vp.dias,
      inversion_total: r2(invP),
      entradas: new Set(entradasP.map((e) => `${e.f}|${e.p}`)).size,
      primera_recompra: primeraRecompra(entradasP),
      existencia: ex ? ex.cantidad : null,
      existencia_unidad: ex && ex.fila.fuente !== 'wincaja' ? (ex.fila.unidad ?? null) : null,
      existencia_fuente: ex ? (ex.fila.fuente ?? null) : null,
      existencia_desglose: ex ? existenciaDesglose(ex.fila) : null,
      unidades_vendidas: limpiarUnidades(vendidasP),
      venta_sin_unidad: sinUnidad(totalP, cubiertoP),
      unidades_recibidas: limpiarUnidades(recibidasP),
      recibido_traspaso: repartoDe('traspaso'),
      enviado_sucursales: repartoDe('salida_sucursal'),
      enviado_rutas: repartoDe('salida_ruta'),
      unidades_hoy: limpiarUnidades(hoyP),
      ultima_venta: vp.ultima === null ? null : sumarDias(hoy, -vp.ultima),
      semanas: porSemana(serieDesde).slice(-8),
      venta_hoy: Math.round(ventasVivo.filter((m) => m.plaza === p && m.fecha === hoy)
        .reduce((a, m) => a + (num(m.importe) ?? 0), 0) * 100) / 100,
      recomendacion: recomendar({
        dia: diaP, venta_total: totalP, inversion_total: invP, dias_con_venta_28: vp.dias, venta_28: vp.venta,
        venta_28_previa: vp.previa, dias_sin_venta: vp.ultima,
        agotado_en: agotadaAqui ? 1 : 0, plazas_con_existencia: hayExistencia ? 1 : 0,
      }, { conCosto: opts.conCosto }),
      margenes: fuenteP ? margenesDe([fuenteP], f.compra_base) : null,
      movimiento: {
        venta_neta_dia: diasHist !== null && diasHist > 0 && netaP !== null ? r2(netaP / diasHist) : null,
        dias: diasHist,
        // Vendido contra lo que hay hoy, en la MISMA unidad base (la de la ficha de la plaza).
        desplazado: ex && vendidoBase !== null && vendidoBase + ex.cantidad > 0
          ? r3(vendidoBase / (vendidoBase + Math.max(0, ex.cantidad)))
          : null,
        lugar: null,
      },
    });
  }

  // [NP.15] Dónde se mueve mejor: venta neta por día desde que llegó a cada plaza. Una plaza con
  // menos de `diasMinimos` de historia no compite: una sola venta la pondría arriba.
  const compiten = plazas
    .filter((x) => x.movimiento.dias !== null && x.movimiento.dias >= CRITERIO_SUCURSAL.diasMinimos
      && x.movimiento.venta_neta_dia !== null && x.movimiento.venta_neta_dia > 0)
    .sort((a, b) => (b.movimiento.venta_neta_dia ?? 0) - (a.movimiento.venta_neta_dia ?? 0));
  compiten.forEach((x, i) => { x.movimiento.lugar = i + 1; });
  const mejor = compiten[0];

  // ── Global ──
  const ventaTotal = serie.reduce((a, b) => a + b, 0);
  const invTotal = todasEntradas.length ? todasEntradas.reduce((a, e) => a + e.i, 0) : null;
  const hitos = Object.fromEntries((HITOS as readonly Hito[]).map((n) => {
    const ven = serie.slice(0, n);
    const inv = lanzamiento ? todasEntradas.filter((e) => (diasEntre(lanzamiento, e.f) ?? 0) < n) : [];
    // [NP.16] Unidades del tramo: la historia de la matvista + lo de hoy, si hoy cae dentro.
    const uni = sumarUnidades({}, f.venta_unidades_hito?.[String(n)]);
    if (lanzamiento) {
      for (const m of ventasVivo.filter((x) => (diasEntre(lanzamiento, x.fecha) ?? n) < n)) sumarUnidades(uni, unidadesDe(m));
    }
    return [n, {
      cerrado: dia !== null && dia >= n,
      inversion: inv.length ? r2(inv.reduce((a, e) => a + e.i, 0)) : null,
      venta: ven.some((x) => x > 0) ? r2(ven.reduce((a, b) => a + b, 0)) : null,
      unidades: limpiarUnidades(uni),
    }];
  })) as Record<Hito, HitoValores>;
  const recompra = primeraRecompra(todasEntradas);
  const plazasConExistencia = [...exPorPlaza.values()].filter((x) => x.cantidad > 0).length;
  const venta30 = hitos[30].venta;

  const fila: NewProductRow = {
    product_id: f.product_id,
    sku: f.sku,
    nombre: f.nombre,
    marca: f.marca,
    proveedor: f.proveedor,
    alta_suite: f.alta_suite,
    alta_en_lote: f.alta_en_lote === true,
    primera_recepcion: f.primera_recepcion ?? (entradasVivo.map((m) => m.fecha).sort()[0] ?? null),
    primera_venta: f.primera_venta ?? (ventasVivo.map((m) => m.fecha).sort()[0] ?? null),
    lanzamiento,
    dia,
    fuentes: Array.isArray(f.fuentes) ? f.fuentes : [],
    etapa: etapaDe(dia),
    estado,
    motivo,
    posible_recodificacion: f.posible_recodificacion === true,
    clasificacion: f.clasificacion,
    nota: f.nota,
    clasificado_por: f.clasificado_por,
    hitos,
    inversion_total: r2(invTotal),
    venta_total: lanzamiento ? Math.round(ventaTotal * 100) / 100 : null,
    venta_por_peso: invTotal !== null && invTotal > 0 ? r2(ventaTotal / invTotal) : null,
    entradas: new Set(todasEntradas.map((e) => `${e.f}|${e.p}`)).size,
    plazas_recibido: new Set(todasEntradas.map((e) => e.p)).size,
    primera_recompra: recompra,
    dia_recompra: lanzamiento ? diasEntre(lanzamiento, recompra) : null,
    plazas_venta: plazas.filter((p) => p.venta_total > 0).length,
    plazas_con_existencia: plazasConExistencia,
    agotado_en: agotadoEn,
    dias_con_venta_30: serie.slice(0, 30).filter((x) => x > 0).length,
    dias_con_venta_28: v.dias,
    venta_28: Math.round(v.venta * 100) / 100,
    tendencia: v.previa !== null && v.previa > 0 ? Math.round((v.venta / v.previa) * 100) / 100 : null,
    ultima_venta: v.ultima === null ? null : sumarDias(hoy, -v.ultima),
    sin_venta_30: dia !== null && dia >= 30 && !(venta30 !== null && venta30 > 0),
    semanas: porSemana(serie),
    venta_hoy: Math.round(ventasVivo.filter((m) => m.fecha === hoy)
      .reduce((a, m) => a + (num(m.importe) ?? 0), 0) * 100) / 100,
    unidades_vendidas: limpiarUnidades(unidadesVendidas),
    venta_sin_unidad: lanzamiento ? sinUnidad(ventaTotal, cubierto) : 0,
    unidades_recibidas: limpiarUnidades(unidadesRecibidas),
    unidades_hoy: limpiarUnidades(unidadesHoy),
    recomendacion: estado === 'seguimiento'
      ? recomendar({
        dia, venta_total: ventaTotal, inversion_total: invTotal, dias_con_venta_28: v.dias, venta_28: v.venta,
        venta_28_previa: v.previa, dias_sin_venta: v.ultima, agotado_en: agotadoEn,
        plazas_con_existencia: plazasConExistencia,
      }, { conCosto: opts.conCosto })
      : null,
    margenes: margenesDe(Object.values(f.margen_plaza ?? {}), f.compra_base),
    mejor_plaza: mejor
      ? { plaza: mejor.plaza, nombre: mejor.nombre, venta_neta_dia: mejor.movimiento.venta_neta_dia ?? 0,
          dias: mejor.movimiento.dias ?? 0 }
      : null,
    llegada: llegadaDe(f, entradasVivo, nombres),
  };
  return { fila, plazas };
}

/**
 * `[NP.16]` Cuándo llegó a la empresa. Primero el barrido del kardex (la orden de entrada `X-A-40`);
 * si el kardex no trae nada, la compra aplicada de la historia o la de hoy. Si entró ANTES por otro
 * camino (un ajuste de inventario, un traspaso), o nunca hubo compra, se dice cuándo y por qué.
 */
export function llegadaDe(
  f: Pick<NewProductSource, 'llegada' | 'primera_recepcion' | 'entradas'>,
  entradasVivo: Movimiento[], nombres: Map<string, string>,
): Llegada | null {
  const sucursales = (codigos: string[]) => [...new Set(codigos)].sort()
    .map((plaza) => ({ plaza, nombre: nombres.get(plaza) ?? null }));
  const k = f.llegada ?? {};
  if (k.compra || k.entrada) {
    const antes = k.entrada && (!k.compra || k.entrada < k.compra)
      ? { fecha: k.entrada, tipo: tipoEntradaTexto(k.entrada_doc ?? '?') }
      : null;
    return { fecha: k.compra ?? null, sucursales: sucursales(k.compra_plazas ?? []), fuente: 'kardex', antes };
  }
  // Sin kardex: la compra aplicada (X-A-20) de la historia, o la que entró hoy.
  const aplicadas = [
    ...(Array.isArray(f.entradas) ? f.entradas : []).map((e) => ({ f: e.f.slice(0, 10), p: e.p })),
    ...entradasVivo.map((m) => ({ f: m.fecha, p: m.plaza })),
  ];
  const fecha = f.primera_recepcion ?? aplicadas.map((x) => x.f).sort()[0] ?? null;
  if (!fecha) return null;
  return {
    fecha, fuente: 'compra_aplicada', antes: null,
    sucursales: sucursales(aplicadas.filter((x) => x.f === fecha).map((x) => x.p)),
  };
}

/** Sólo los lanzamientos reales cuentan para cohortes y KPIs. */
export const cuentaParaKpis = (f: NewProductRow): boolean => f.estado === 'seguimiento';

function acumular(filas: NewProductRow[]) {
  const conInv = filas.filter((f) => f.inversion_total !== null);
  const inversion = conInv.length ? conInv.reduce((s, f) => s + (f.inversion_total ?? 0), 0) : null;
  const ventaConInv = conInv.reduce((s, f) => s + (f.venta_total ?? 0), 0);
  const con30 = filas.filter((f) => f.dia !== null && f.dia >= 30);
  return {
    productos: filas.length,
    con_inversion: conInv.length,
    inversion: r2(inversion),
    venta: r2(filas.reduce((s, f) => s + (f.venta_total ?? 0), 0)) ?? 0,
    // Mismo universo arriba y abajo: la venta de los productos SIN inversión medida no se cuela
    // en el numerador.
    venta_por_peso: inversion !== null && inversion > 0 ? r2(ventaConInv / inversion) : null,
    recomprados: filas.filter((f) => f.primera_recompra !== null).length,
    con_30_dias: con30.length,
    sin_venta_30: con30.filter((f) => f.sin_venta_30).length,
  };
}

export function construirCohortes(filas: NewProductRow[]): Cohorte[] {
  const porMes = new Map<string, NewProductRow[]>();
  for (const f of filas) {
    if (!cuentaParaKpis(f) || !f.lanzamiento) continue;
    const mes = f.lanzamiento.slice(0, 7);
    const lista = porMes.get(mes);
    if (lista) lista.push(f);
    else porMes.set(mes, [f]);
  }
  return [...porMes.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([mes, lista]) => ({ mes, ...acumular(lista) }));
}

export function construirResumen(filas: NewProductRow[]): Resumen {
  const kpi = filas.filter(cuentaParaKpis);
  const a = acumular(kpi);
  const cuenta = (e: Estado) => filas.filter((f) => f.estado === e).length;
  const ver = (v: Veredicto) => kpi.filter((f) => f.recomendacion?.veredicto === v).length;
  return {
    total: filas.length,
    seguimiento: kpi.length,
    por_confirmar: kpi.filter((f) => f.clasificacion === null).length,
    sin_movimiento: cuenta('sin_movimiento'),
    no_medible: cuenta('no_medible'),
    excluido: cuenta('excluido'),
    por_etapa: {
      mes_1: kpi.filter((f) => f.etapa === 'mes_1').length,
      mes_2: kpi.filter((f) => f.etapa === 'mes_2').length,
      mes_3: kpi.filter((f) => f.etapa === 'mes_3').length,
      graduado: kpi.filter((f) => f.etapa === 'graduado').length,
    },
    por_veredicto: {
      recomprar: ver('recomprar'), esperar: ver('esperar'), revisar: ver('revisar'),
      no_recomprar: ver('no_recomprar'), pronto: ver('pronto'),
    },
    inversion: a.inversion,
    venta: a.venta,
    venta_hoy: Math.round(kpi.reduce((s, f) => s + f.venta_hoy, 0) * 100) / 100,
    venta_por_peso: a.venta_por_peso,
    recomprados: a.recomprados,
    con_30_dias: a.con_30_dias,
    sin_venta_30: a.sin_venta_30,
  };
}

/**
 * El costo de compra es dato sensible (mismo criterio que la pestaña Costos, `[CAT-COSTO.4]`).
 * Sin el permiso se quita del payload en el SERVIDOR: ocultarlo sólo en pantalla no lo protege.
 */
export function ocultarCosto(filas: NewProductRow[]): NewProductRow[] {
  return filas.map((f) => ({
    ...f,
    inversion_total: null,
    venta_por_peso: null,
    hitos: Object.fromEntries((HITOS as readonly Hito[]).map((n) => [n, { ...f.hitos[n], inversion: null }])) as Record<Hito, HitoValores>,
    // [NP.15] Un margen deja ver el costo (venta y % de margen bastan para despejarlo).
    margenes: null,
  }));
}

export function ocultarCostoPlazas(plazas: PlazaRow[]): PlazaRow[] {
  return plazas.map((p) => ({ ...p, inversion_total: null, margenes: null }));
}

export function esKindValido(v: unknown): v is NewProductKind {
  return typeof v === 'string' && (NEW_PRODUCT_KINDS as readonly string[]).includes(v);
}
