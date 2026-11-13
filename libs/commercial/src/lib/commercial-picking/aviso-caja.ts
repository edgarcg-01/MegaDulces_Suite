import type { AvisoCajaRenglon } from '@megadulces/contracts';

/**
 * `[GP.9.2]` La caja que el surtidor tiene enfrente puede no ser la que dice la hoja — reglas PURAS.
 *
 * El caso que lo pidió (Canindo, embarque `06UD4101-0001823`): el pedido se capturó el 26-oct como
 * 10 CJA de 40 = 400 PAQ; el 29-oct la ficha de Kepler bajó la caja a 25. La hoja del surtidor dice
 * «10 CJA · 400 PAQ»: si cuenta 10 cajas nuevas salen 250 PAQ, y la factura re-presentó 400 como 16 CJA.
 *
 * Dos señales, de la más fuerte a la más débil:
 *  1. **capturada_con_otra** — el renglón del pedido trae un factor (`kdm2.c58`) distinto al de la
 *     ficha de hoy. Sale de `analytics.v_erp_order_line_box_factor` (AX.22.1), `status = factor_cambio`.
 *     La cantidad que manda es la BASE: se cuenta en piezas/paquetes, no en cajas.
 *  2. **transicion** — la ficha de esa presentación cambió en los últimos 30 días
 *     (`analytics.kepler_ficha_history`, que existe desde el 2026-11-04: un cambio anterior a esa
 *     fecha sólo lo ve la señal 1). Puede haber cajas viejas y nuevas en el mismo anaquel.
 *     Medido el 2026-11-12: 1,678 cambios de caja en 173 productos en 8 días (el resto de los 5,752
 *     «cambio» son de costo y no cuentan).
 */

export interface CajaCapturada {
  sku: string;
  captured_unit: string | null;
  captured_factor: number | null;
  current_factor: number | null;
}

/** La última fila de la historia con un cambio de caja, y la anterior (lag). */
export interface CambioFicha {
  sku: string;
  u2: string | null; f2: number | null; u3: string | null; f3: number | null;
  pu2: string | null; pf2: number | null; pu3: string | null; pf3: number | null;
  observado_at: string;
}

const norm = (u: string | null | undefined) => (u ?? '').trim().toUpperCase();
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const fmt = (n: number | null) => (n == null ? '?' : Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''));
const fechaCorta = (iso: string | null): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${Number(m[3])} ${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(m[2]) - 1]}` : '';
};

/** Unidad → factor declarado (> 0). Un factor 0 o vacío es «no declarado», no un factor. */
function factores(pares: Array<[string | null, number | string | null]>): Map<string, number> {
  const m = new Map<string, number>();
  for (const [u, f] of pares) {
    const k = norm(u);
    const v = num(f);
    if (k && v !== null && v > 0 && !m.has(k)) m.set(k, v);
  }
  return m;
}

/**
 * De una fila de historia, el cambio de factor de la presentación `unidad`, comparando **por nombre
 * de unidad, no por casilla**. Medido el 2026-11-12 en la 06: 150 de 178 «cambios» eran Kepler
 * moviendo la CJA de la 2ª a la 3ª presentación con el MISMO factor (u2 CJA/12 → u3 CJA/12, u2 PAQ/1):
 * la caja no cambió y no se avisa. Tampoco cuando antes no estaba declarada (0 → 40) ni cuando
 * desaparece: sin los dos factores no hay «de X a Y» que decir.
 */
export function cambioDeLaUnidad(c: CambioFicha, unidad: string): { antes: number; hoy: number } | null {
  const u = norm(unidad);
  const antes = factores([[c.pu2, c.pf2], [c.pu3, c.pf3]]).get(u);
  const hoy = factores([[c.u2, c.f2], [c.u3, c.f3]]).get(u);
  if (antes === undefined || hoy === undefined || antes === hoy) return null;
  return { antes, hoy };
}

/** De las filas de 30 días de un SKU, la más reciente que cambió el factor de `unidad`. */
export function ultimoCambioDe(cambios: CambioFicha[], unidad: string | null): { fila: CambioFicha; antes: number; hoy: number } | null {
  if (!unidad) return null;
  const orden = [...cambios].sort((a, b) => b.observado_at.localeCompare(a.observado_at));
  for (const fila of orden) {
    const d = cambioDeLaUnidad(fila, unidad);
    if (d) return { fila, ...d };
  }
  return null;
}

/**
 * El aviso de un renglón de la ola. `capturadas` = los renglones de los pedidos de esta ola con ese
 * SKU en `factor_cambio` (puede haber varios pedidos); `cambios` = las filas de su ficha con algún
 * movimiento de presentación en 30 días. `unidadPresentacion`/`qtyBase`/`unidadBase` = la hoja.
 */
export function avisoCaja(
  capturadas: CajaCapturada[],
  cambios: CambioFicha[],
  unidadPresentacion: string | null,
  qtyBase: number,
  unidadBase: string | null,
): AvisoCajaRenglon | null {
  const c = capturadas.find((x) => num(x.captured_factor) !== null && num(x.current_factor) !== null
    && num(x.captured_factor) !== num(x.current_factor));
  if (c) {
    const unidad = norm(c.captured_unit) || norm(unidadPresentacion) || 'CAJA';
    const antes = num(c.captured_factor);
    const hoy = num(c.current_factor);
    const base = norm(unidadBase);
    return {
      tipo: 'capturada_con_otra', unidad, factor_antes: antes, factor_hoy: hoy,
      desde: ultimoCambioDe(cambios, unidad)?.fila.observado_at ?? null,
      texto: `El pedido se capturó con ${unidad} de ${fmt(antes)} y hoy la ${unidad} es de ${fmt(hoy)}. `
        + `Cuenta ${fmt(qtyBase)}${base ? ' ' + base : ''}, no cajas.`,
    };
  }
  const t = ultimoCambioDe(cambios, unidadPresentacion);
  if (t) {
    const unidad = norm(unidadPresentacion);
    const cuando = fechaCorta(t.fila.observado_at);
    return {
      tipo: 'transicion', unidad, factor_antes: t.antes, factor_hoy: t.hoy, desde: t.fila.observado_at,
      texto: `La ${unidad} cambió de ${fmt(t.antes)} a ${fmt(t.hoy)}${cuando ? ' el ' + cuando : ''}: `
        + 'revisa cuántas piezas trae antes de contarla por caja.',
    };
  }
  return null;
}
