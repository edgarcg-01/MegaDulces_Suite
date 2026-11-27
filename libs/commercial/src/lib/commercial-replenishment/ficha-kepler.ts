/**
 * `[PQ.19]` D24 — **El factor de caja según la FICHA de Kepler (`md.kdii`) de un servidor.**
 *
 * Es la misma regla que `analytics.v_kepler_unit_ladder` (mig `20260915120000`), escrita en TS
 * para leerla en el servidor donde se va a escribir, no en el ODS:
 *
 *   Base c11 · Unidad Dos c80/c81 (costo c78) · Unidad Tres c83/c84 (costo c79) · costo base c77.
 *
 * - Factor efectivo de un peldaño: el capturado si es > 1; si no, `round(costo_peldaño / costo_base)`
 *   cuando eso es > 1. Un peldaño rotulado pero vacío NO es un peldaño.
 * - La caja es el peldaño de MAYOR factor (la escalera puede venir corrida: SKU 14030).
 * - Sin peldaños superiores rotulados → unidad única, factor 1. Rotulado sin factor ni costo →
 *   `null` (ignorancia, no una unidad).
 *
 * ⛔ Para qué existe: el traspaso viaja en unidad base (D24), así que la cantidad escrita es
 * `cajas × piezas_por_caja`. Si el factor de la Suite y el de la ficha del ORIGEN no coinciden,
 * el documento saldría con otra cantidad —el error de 50× de `[KR.6]`— viéndose perfecto en
 * pantalla. El adapter contrasta y rechaza.
 */
import type { RechazoKepler } from '@megadulces/contracts';
import { piezasEnteras } from './fraccion-caja';

export interface FilaFichaKepler {
  c11?: unknown; c80?: unknown; c81?: unknown; c83?: unknown; c84?: unknown;
  c77?: unknown; c78?: unknown; c79?: unknown;
}

const rotulo = (v: unknown): string | null => {
  const s = String(v ?? '').trim().toUpperCase();
  return s ? s : null;
};

const numero = (v: unknown): number | null => {
  const s = String(v ?? '').replace(/[^0-9.]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const efectivo = (cap: number | null, costo: number | null, costoBase: number | null): number | null => {
  if (cap !== null && cap > 1) return cap;
  if (costoBase !== null && costoBase > 0 && costo !== null && costo > 0 && costo / costoBase > 1) return Math.round(costo / costoBase);
  return null;
};

/**
 * `[PQ.87]` Un peldaño que REPITE la base no es una caja: sin rótulo, o con el mismo rótulo que la
 * base, factor ≤ 1 y costo vacío o igual al de la base (±1 %). Kepler llena así la ficha de los
 * productos que se compran sueltos (15151 Lico: PAQ / PAQ ×1 $30.45 / PAQ ×1 $30.45).
 */
const repiteBase = (u: string | null, u1: string | null, cap: number | null, costo: number | null, c1: number | null): boolean =>
  u === null || (u === u1 && (cap ?? 0) <= 1 && (!costo || (c1 !== null && c1 > 0 && Math.abs(costo - c1) <= 0.01 * c1)));

/** Unidad base y factor de caja de la ficha. `factor: null` = la ficha no lo dice. */
export function factorFichaKepler(f: FilaFichaKepler): { unidad_base: string | null; factor: number | null } {
  const u1 = rotulo(f.c11), u2 = rotulo(f.c80), u3 = rotulo(f.c83);
  const c1 = numero(f.c77);
  const f2 = efectivo(numero(f.c81), numero(f.c78), c1);
  const f3 = efectivo(numero(f.c84), numero(f.c79), c1);
  let factor: number | null;
  if (f3 !== null && f3 >= (f2 ?? 0)) factor = f3;
  else if (f2 !== null) factor = f2;
  else if (u2 === null && u3 === null) factor = 1;
  else if (c1 !== null && c1 > 0
    && repiteBase(u2, u1, numero(f.c81), numero(f.c78), c1)
    && repiteBase(u3, u1, numero(f.c84), numero(f.c79), c1)) factor = 1;
  else factor = null;
  return { unidad_base: u1, factor };
}

/** `[PQ.19]` D24 — cuánto puede diferir el factor de caja de la Suite del de la ficha del origen. */
export const TOLERANCIA_FACTOR_FICHA = 0.001;

/**
 * `[PQ.19]` D24 — ¿el factor de caja de la Suite es el de la ficha de Kepler? `false` si la ficha no
 * da factor. La usan el sink (al escribir el traspaso) y `[AB.PM.3]` (al capturarlo): una sola regla.
 */
export function factorCoincideConFicha(piezasPorCaja: unknown, ficha: { factor: number | null } | null | undefined): boolean {
  const f = ficha?.factor;
  return f != null && !(Math.abs(f - Number(piezasPorCaja)) > TOLERANCIA_FACTOR_FICHA);
}

/**
 * `[AB.PM.3]` Las cajas que se guardan para `base` unidades base: lo que `enviar` pone en `final_qty`
 * (3 decimales, como la columna) y lo que el sink vuelve a pasar a piezas. Una sola cuenta para los dos.
 */
export function cajasDeBase(base: number, piezasPorCaja: number): number {
  return Math.round((Number(base) / Number(piezasPorCaja)) * 1000) / 1000;
}

/**
 * `[AB.PM.3]` R8 (d) — **las tres revisiones del traspaso del sink, hechas AL CAPTURAR.**
 *
 * El sink (`kepler-requisition-sink.adapter.ts`, `[PQ.19]` D24) escribe el traspaso entero en unidad
 * base y lo rechaza completo si UN renglón no cuadra: (1) las cajas no vuelven a piezas enteras —sin
 * factor de la Suite, tampoco—, (2) la ficha del origen no tiene unidad base, (3) el factor de la Suite
 * no es el de la ficha del origen. Aquí se revisa lo mismo con lo que la Suite ya sabe —el factor del
 * almacén que pide (`mv_warehouse_box_factor`, el que usa `pushToKepler`) y la ficha del origen leída
 * del ODS (`analytics.v_kepler_unit_ladder`, la gemela de `factorFichaKepler`)— para que el renglón
 * diga «Kepler lo rechazaría» y no tumbe a los demás.
 *
 * Sin `cantidadBase` (el buscador, antes de capturar) se revisa sólo lo que no depende de la cantidad.
 */
export function rechazoDelTraspaso(r: {
  sku: string;
  cantidadBase?: number | null;
  piezasPorCaja: number | null | undefined;
  ficha: { unidad_base: string | null; factor: number | null } | null | undefined;
}): RechazoKepler | null {
  const bf = Number(r.piezasPorCaja);
  if (!(bf > 0)) return 'sin_factor_suite';
  if (r.cantidadBase != null) {
    const base = Number(r.cantidadBase);
    const pz = piezasEnteras({ sku: r.sku, final_qty: cajasDeBase(base, bf), piezas_por_caja: bf });
    // Además de entero, tiene que ser LO PEDIDO: si no, Kepler escribiría otra cantidad.
    if (pz === null || pz !== base) return 'sin_piezas_enteras';
  }
  if (!r.ficha?.unidad_base) return 'sin_ficha_origen';
  if (!factorCoincideConFicha(bf, r.ficha)) return 'factor_distinto';
  return null;
}

/**
 * ⛔ `[PQ.87]` **La ficha de la sucursal donde se escribe manda sobre la caja de la Suite** (compra).
 * Si Kepler dice que el producto no tiene caja (factor 1) y la Suite lo pidió en cajas de N, el
 * costo de Kepler es por unidad y la Suite lo dividiría entre N: la OC 0000346 de Morelia Abastos
 * (2026-11-06) salió con el paquete de Lico a $0.76 contra $30.45 (÷40). Se rechaza nombrando los
 * SKU; no se adivina cuál de los dos tiene razón. Con caja 1 en los dos lados, el renglón va en la
 * unidad base de la ficha (`sinCaja`: sku → unidad), no en `CJA`, que esa ficha no tiene.
 * `[PQ.91]` Sin factor de la Suite cuenta como 1, igual que en la mesa (`GREATEST(COALESCE(bf, 1), 1)`).
 */
export function frenoFichaSinCaja(
  lineas: ReadonlyArray<{ sku: string; piezas_por_caja?: number | null }>,
  ficha: ReadonlyMap<string, { unidad_base: string | null; factor: number | null }>,
  sucursal: string,
): { motivo: string | null; sinCaja: Map<string, string> } {
  const ppc = (l: { piezas_por_caja?: number | null }): number => (Number(l.piezas_por_caja) > 0 ? Number(l.piezas_por_caja) : 1);
  const choca = lineas.filter((l) => ficha.get(l.sku)?.factor === 1 && ppc(l) > 1);
  if (choca.length) {
    const unidad = (sku: string): string => ficha.get(sku)?.unidad_base ?? 'unidad';
    return {
      motivo: `En Kepler (sucursal ${sucursal}) ${choca.slice(0, 5).map((l) => `${l.sku} se compra por ${unidad(l.sku)}`).join(', ')}${choca.length > 5 ? ` y ${choca.length - 5} más` : ''}, sin caja, y la Suite los pidió en cajas de ${[...new Set(choca.map(ppc))].join('/')}: el costo saldría dividido. No se escribe; vuelve a capturar esos renglones cuando la mesa los muestre por ${unidad(choca[0].sku)}.`,
      sinCaja: new Map(),
    };
  }
  const sinCaja = new Map<string, string>();
  for (const l of lineas) {
    const f = ficha.get(l.sku);
    if (f?.factor === 1 && f.unidad_base) sinCaja.set(l.sku, f.unidad_base);
  }
  return { motivo: null, sinCaja };
}

/**
 * `[PQ.105]` La celda cuya caja la dice la FICHA de Kepler de la sucursal (su escalera de
 * unidades, fuente de `analytics.v_warehouse_box_factor`): ahí la caja de la demanda es la de la
 * ficha, no el override manual ni el factor_sale. Sólo con `suf = 1` (demanda en la unidad base de
 * Kepler): el granel trae la demanda en KG y su `suf × bf` ya es la caja (57009, cubeta de 20 KG).
 * Misma regla que `FICHA_KEPLER` en `import-replenishment-plan.js`; alias `db` y `fz`.
 */
export const FICHA_KEPLER_SQL =
  "(db.factor_source IN ('kepler_unidad_unica', 'kepler_ficha', 'kepler_ficha_costo', 'kepler_ficha_contradice_costo') AND fz.suf = 1)";

/**
 * `[COT.7]` Cuántas unidades base trae la presentación `rotuloPres` según la ficha: 1 si es la
 * base (`c11`), el factor efectivo de la Unidad Dos (`c80`) o de la Tres (`c83`) si el rótulo es
 * el suyo, y `null` si la ficha no declara esa presentación. Con la misma regla de factor efectivo
 * que `factorFichaKepler`. Ej. (01, 2026-11-03): 32008 `CJA` → 14 · 70500 `KG` → 2 · 44415 `PAQ` → 1.
 */
export function factorPresentacionFicha(f: FilaFichaKepler, rotuloPres: string | null | undefined): number | null {
  const p = rotulo(rotuloPres);
  if (p === null) return null;
  if (p === rotulo(f.c11)) return 1;
  const c1 = numero(f.c77);
  if (p === rotulo(f.c80)) return efectivo(numero(f.c81), numero(f.c78), c1);
  if (p === rotulo(f.c83)) return efectivo(numero(f.c84), numero(f.c79), c1);
  return null;
}

/**
 * `[COT.45]` El factor EXACTO de una presentación cuando la vista lo dejó entero. `v_label_presentations`
 * y `v_label_prices` hacen `floor(c81)` / `floor(c84)::integer`, y Kepler sí guarda decimales en 8
 * artículos por sucursal (medido el 2026-11-18): el bulto 95579 trae 19.75 PAQ y la vista dice 19, la
 * caja 97235 trae 10.80 KG y la vista dice 10, pero el PRECIO es el de la presentación completa. Con 19
 * el cotizador repartía el precio entre menos unidades y el pedido rebotaba en Kepler (19 contra 19.75).
 *
 * Se usa la ficha (`c81` de la Unidad Dos si el rótulo es `c80`, `c84` de la Tres si es `c83`) SÓLO si
 * el entero de la ficha es el número de la vista: eso prueba que la vista lo truncó. Si no coinciden,
 * se queda el de la vista (no se mezcla el factor de una presentación con el de otra).
 */
export function factorExactoDeFicha(
  vista: number | null,
  rotuloPres: string | null | undefined,
  f: { u2?: unknown; f2?: unknown; u3?: unknown; f3?: unknown } | null | undefined,
): number | null {
  const p = rotulo(rotuloPres);
  if (vista === null || p === null || !f) return vista;
  const exacto = p === rotulo(f.u3) ? Number(f.f3) : p === rotulo(f.u2) ? Number(f.f2) : NaN;
  if (!Number.isFinite(exacto) || exacto <= 1 || exacto === vista) return vista;
  return Math.floor(exacto) === Math.floor(vista) ? exacto : vista;
}
