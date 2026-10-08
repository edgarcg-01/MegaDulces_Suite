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
  clasificacion: NewProductKind | null;
  nota: string | null;
  clasificado_por: string | null;
}

/** Lo que pasó desde el corte (ODS en vivo). */
export interface Movimiento {
  product_id: string;
  tipo: 'venta' | 'entrada';
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
}

/** La existencia dicha también en la unidad mayor de la plaza. */
export interface CantidadEnUnidad {
  unidad: string;
  cantidad: number;
}

export interface HitoValores {
  /** El día del hito ya pasó: la cifra es definitiva. `false` = va en curso. */
  cerrado: boolean;
  inversion: number | null;
  venta: number | null;
}

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
  /** La misma existencia en la unidad mayor de la plaza, si la ficha la declara con su factor. */
  existencia_mayor: CantidadEnUnidad | null;
  unidades_vendidas: Unidades;
  venta_sin_unidad: number;
  unidades_recibidas: Unidades;
  unidades_hoy: Unidades;
  ultima_venta: string | null;
  /** Venta por semana de las últimas 8 semanas (la última puede ir incompleta). */
  semanas: number[];
  venta_hoy: number;
  recomendacion: Recomendacion;
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
const r1 = (v: number) => Math.round(v * 10) / 10;

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
 * La existencia en la unidad mayor de la plaza. Kepler: el peldaño mayor de SU ficha (`kdii`),
 * nunca de otra plaza ni de un catálogo. Wincaja: el divisor de presentación (ADR-055), que es
 * la caja. Sin factor > 1 no se dice nada: no se inventa la caja.
 */
export function existenciaMayor(e: Existencia | undefined): CantidadEnUnidad | null {
  if (!e) return null;
  const cant = num(e.cantidad) ?? 0;
  if (e.fuente === 'wincaja') {
    const f = num(e.factor);
    return f !== null && f > 1 ? { unidad: 'CJA', cantidad: r1(cant / f) } : null;
  }
  const f = num(e.factor_mayor);
  const mayor = (e.unidad_mayor ?? '').trim().toUpperCase();
  const base = (e.unidad ?? '').trim().toUpperCase();
  if (!mayor || f === null || f <= 1 || mayor === base) return null;
  return { unidad: mayor, cantidad: r1(cant / f) };
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

  // Un producto sin historia que HOY entra o se vende arranca hoy: "Nuevo · día 0".
  const primeraViva = vivo.map((m) => m.fecha).sort()[0] ?? null;
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
    const primeraAct = [primeraEntrada, primeraVentaP].filter((x): x is string => !!x).sort()[0] ?? null;
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
      existencia_mayor: ex ? existenciaMayor(ex.fila) : null,
      unidades_vendidas: limpiarUnidades(vendidasP),
      venta_sin_unidad: sinUnidad(totalP, cubiertoP),
      unidades_recibidas: limpiarUnidades(recibidasP),
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
    });
  }

  // ── Global ──
  const ventaTotal = serie.reduce((a, b) => a + b, 0);
  const invTotal = todasEntradas.length ? todasEntradas.reduce((a, e) => a + e.i, 0) : null;
  const hitos = Object.fromEntries((HITOS as readonly Hito[]).map((n) => {
    const ven = serie.slice(0, n);
    const inv = lanzamiento ? todasEntradas.filter((e) => (diasEntre(lanzamiento, e.f) ?? 0) < n) : [];
    return [n, {
      cerrado: dia !== null && dia >= n,
      inversion: inv.length ? r2(inv.reduce((a, e) => a + e.i, 0)) : null,
      venta: ven.some((x) => x > 0) ? r2(ven.reduce((a, b) => a + b, 0)) : null,
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
  };
  return { fila, plazas };
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
  }));
}

export function ocultarCostoPlazas(plazas: PlazaRow[]): PlazaRow[] {
  return plazas.map((p) => ({ ...p, inversion_total: null }));
}

export function esKindValido(v: unknown): v is NewProductKind {
  return typeof v === 'string' && (NEW_PRODUCT_KINDS as readonly string[]).includes(v);
}
