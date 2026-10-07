/**
 * `[NP.2]` Productos nuevos — la lógica pura de la pantalla: etapa, estado, hitos 30/60/90,
 * cohortes por mes de lanzamiento y el ocultamiento del costo.
 *
 * Vive aparte del servicio para poder probarse sin base. La consulta sólo trae filas de
 * `analytics.mv_new_products`; todo lo que se DECIDE sobre ellas está aquí.
 *
 * Reglas que no se negocian (ADR-056):
 *   · Lo que no se pudo medir va NULL, nunca 0. Una inversión NULL es "no medida" (el producto
 *     entró por el CEDIS cuando era Wincaja, o por traspaso), no "no costó nada".
 *   · Un hito que todavía no llega no es un hito cerrado: se publica marcado como EN CURSO.
 *   · "Venta por cada peso invertido" sólo se calcula sobre productos con inversión medida, y en
 *     la cohorte sobre el MISMO universo en el numerador y en el denominador.
 */

export const NEW_PRODUCT_KINDS = ['nuevo', 'recodificacion', 'promocion', 'no_mercancia'] as const;
export type NewProductKind = (typeof NEW_PRODUCT_KINDS)[number];

/** Las tres clasificaciones que sacan al producto de los KPIs: no son lanzamientos. */
const KINDS_FUERA: ReadonlySet<NewProductKind> = new Set(['recodificacion', 'promocion', 'no_mercancia']);

export const HITOS = [30, 60, 90] as const;
export type Hito = (typeof HITOS)[number];

/** En qué tramo de su seguimiento va. `sin_movimiento` = dado de alta, sin entrada ni venta. */
export type Etapa = 'sin_movimiento' | 'mes_1' | 'mes_2' | 'mes_3' | 'graduado';

/**
 * Si cuenta para los KPIs, y si no, por qué. Es lo que separa "nuevo" de "código nuevo".
 *   seguimiento    — lanzamiento real (o por confirmar): entra a los KPIs.
 *   sin_movimiento — dado de alta y todavía sin entrada ni venta: se lista, no tiene cifras.
 *   no_medible     — no hay 90 días de historia antes de su primera actividad: no se puede
 *                    afirmar que sea nuevo.
 *   excluido       — promoción, descuento, descontinuado, o Compras dijo que no es lanzamiento.
 */
export type Estado = 'seguimiento' | 'sin_movimiento' | 'no_medible' | 'excluido';

/** Una fila tal como sale de la matvista + el día y la clasificación de Compras. */
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
  dia: number | null;
  /** En qué fuentes se vio: kepler (tienda), ruta, wincaja, entradas. */
  fuentes: string[];
  sin_movimiento: boolean;
  no_medible: boolean;
  exclusion_auto: string | null;
  posible_recodificacion: boolean;
  inversion_30: number | null;
  inversion_60: number | null;
  inversion_90: number | null;
  inversion_total: number | null;
  entradas: number;
  plazas_recibido: number;
  primera_recompra: string | null;
  venta_30: number | null;
  venta_60: number | null;
  venta_90: number | null;
  venta_total: number | null;
  dias_con_venta_30: number;
  plazas_venta: number;
  ultima_venta: string | null;
  plazas_con_existencia: number;
  clasificacion: NewProductKind | null;
  nota: string | null;
  clasificado_por: string | null;
}

export interface HitoValores {
  /** El día del hito ya pasó: la cifra es definitiva. `false` = va en curso. */
  cerrado: boolean;
  inversion: number | null;
  venta: number | null;
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
  dias_con_venta_30: number;
  ultima_venta: string | null;
  /** Ya cumplió 30 días y no vendió nada en ellos. */
  sin_venta_30: boolean;
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
  inversion: number | null;
  venta: number;
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
    return { estado: 'no_medible', motivo: 'No hay 90 días de historia antes de su primera actividad' };
  }
  return { estado: 'seguimiento', motivo: null };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r2 = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);

function diasEntre(desde: string | null, hasta: string | null): number | null {
  if (!desde || !hasta) return null;
  const a = Date.parse(`${desde.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${hasta.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null;
}

export function aFila(f: NewProductSource): NewProductRow {
  const dia = f.dia === null || f.dia === undefined ? null : Number(f.dia);
  const { estado, motivo } = estadoDe(f);
  const inversion = (n: Hito) => num(f[`inversion_${n}` as const]);
  const venta = (n: Hito) => num(f[`venta_${n}` as const]);
  const hitos = Object.fromEntries(HITOS.map((n) => [n, {
    cerrado: dia !== null && dia >= n,
    inversion: r2(inversion(n)),
    venta: r2(venta(n)),
  }])) as Record<Hito, HitoValores>;
  const invTotal = r2(num(f.inversion_total));
  const ventaTotal = r2(num(f.venta_total));
  const venta30 = num(f.venta_30);
  return {
    product_id: f.product_id,
    sku: f.sku,
    nombre: f.nombre,
    marca: f.marca,
    proveedor: f.proveedor,
    alta_suite: f.alta_suite,
    alta_en_lote: f.alta_en_lote === true,
    primera_recepcion: f.primera_recepcion,
    primera_venta: f.primera_venta,
    lanzamiento: f.lanzamiento,
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
    inversion_total: invTotal,
    venta_total: ventaTotal,
    venta_por_peso: invTotal !== null && invTotal > 0 ? r2((ventaTotal ?? 0) / invTotal) : null,
    entradas: Number(f.entradas) || 0,
    plazas_recibido: Number(f.plazas_recibido) || 0,
    primera_recompra: f.primera_recompra,
    dia_recompra: diasEntre(f.lanzamiento, f.primera_recompra),
    plazas_venta: Number(f.plazas_venta) || 0,
    plazas_con_existencia: Number(f.plazas_con_existencia) || 0,
    dias_con_venta_30: Number(f.dias_con_venta_30) || 0,
    ultima_venta: f.ultima_venta,
    sin_venta_30: dia !== null && dia >= 30 && !(venta30 !== null && venta30 > 0),
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
    inversion: a.inversion,
    venta: a.venta,
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
    hitos: Object.fromEntries(HITOS.map((n) => [n, { ...f.hitos[n], inversion: null }])) as Record<Hito, HitoValores>,
  }));
}

export function esKindValido(v: unknown): v is NewProductKind {
  return typeof v === 'string' && (NEW_PRODUCT_KINDS as readonly string[]).includes(v);
}
