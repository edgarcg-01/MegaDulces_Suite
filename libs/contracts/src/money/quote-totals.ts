/**
 * `[E.19]` La cuenta de una cotización — UNA sola, para el servidor, la pantalla y el papel.
 *
 * Hasta el 2026-10-21 había tres: la del servidor (`recalcTotals`), y una por cada pantalla que
 * arma el entregable. Las dos de las pantallas divergían entre sí y de la del servidor, y el papel
 * que se le manda al cliente no cerraba (auditoría `AUDITORIA_COTIZACIONES_2026-10-21.md`, C1/C2):
 *   · el detalle restaba el descuento del cliente a un subtotal que ya lo traía y no traía IVA;
 *   · aplicaba como "descuento del renglón" el de volumen/promo, que YA está dentro del precio
 *     unitario — medido: 123 renglones de 18 cotizaciones impresos $8,539.97 por debajo.
 *
 * La regla (la misma del servidor, `quote-pricing.service.ts` `recalcTotals`):
 *
 *     importe     Σ importes de renglón (precios cotizados, IVA incluido)
 *   − descuento   el % negociado del CLIENTE: capa de DOCUMENTO, nunca toca el precio unitario
 *   = total       round(importe × (1 − %))
 *     base        round(total / 1.16)      · IVA = total − base   (el precio ya trae el IVA)
 *
 * ⚠️ El descuento por volumen o promoción NO aparece acá: ya está dentro del precio unitario de
 * cada renglón. Aplicarlo otra vez fue justamente el defecto.
 *
 * ⚠️ DEUDA con nombre: el servidor todavía calcula esto en su propio `recalcTotals` (no importa
 * esta función). `quote-totals.spec.ts` fija que las dos den lo mismo; mudar el servidor a esta
 * función es parte del paso de escrituras de la auditoría, donde se prueba contra base real.
 */

/** Tasa de IVA con la que el servidor descompone el total (`DEFAULT_TAX_RATE`). */
export const QUOTE_TAX_RATE = 0.16;

export interface QuoteTotals {
  /** Σ importes de los renglones CON precio. */
  importe: number;
  /** El % del cliente tal como está congelado; null = no hay descuento configurado. */
  descuento_pct: number | null;
  /** importe − total. Exacto por construcción. */
  descuento: number;
  total: number;
  base_sin_iva: number;
  iva: number;
  /**
   * Importe neto de cada renglón, en el mismo orden que entró, con el descuento del cliente
   * repartido de modo que **Σ netos = total al centavo**. null = renglón sin precio.
   */
  netos: Array<number | null>;
  /** Renglones que no entran a la cuenta porque no tienen precio. */
  sin_precio: number;
}

/** Mismo redondeo que el servidor (`Math.round((n + EPSILON) × 100) / 100`). */
export function redondear2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * @param importes  `line_total` de cada renglón; `null` = el renglón no tiene precio.
 * @param pct       el `terms_discount_pct` congelado de la cotización; null/0 = sin descuento.
 */
export function totalesCotizacion(importes: Array<number | null>, pct: number | null): QuoteTotals {
  const p = pct !== null && Number.isFinite(pct) && pct > 0 ? pct : null;
  // Se suma en centavos enteros: sumar flotantes de dos decimales arrastra error.
  const centavos = importes.map((x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 100)));
  const importeCent = centavos.reduce<number>((a, c) => a + (c ?? 0), 0);
  const importe = importeCent / 100;
  const total = p ? redondear2(importe * (1 - p / 100)) : redondear2(importe);
  const base = redondear2(total / (1 + QUOTE_TAX_RATE));
  const iva = redondear2(total - base);

  // Reparto del descuento por mayor residuo: cada renglón recibe su parte proporcional en
  // centavos y los centavos que sobran van a los de mayor fracción. Así la columna de netos
  // suma EXACTO al total que se imprime abajo — una columna que no suma es peor que no tenerla.
  const totalCent = Math.round(total * 100);
  const factor = importeCent > 0 ? totalCent / importeCent : 0;
  const crudos = centavos.map((c) => (c === null ? null : c * factor));
  const pisos = crudos.map((x) => (x === null ? null : Math.floor(x + 1e-9)));
  let sobran = totalCent - pisos.reduce<number>((a, x) => a + (x ?? 0), 0);
  const orden = crudos
    .map((x, i) => ({ i, frac: x === null ? -1 : x - (pisos[i] as number) }))
    .filter((o) => o.frac >= 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const netosCent = [...pisos];
  for (let k = 0; sobran > 0 && orden.length > 0; k = (k + 1) % orden.length, sobran--) {
    const i = orden[k].i;
    netosCent[i] = (netosCent[i] as number) + 1;
  }

  return {
    importe,
    descuento_pct: p,
    descuento: redondear2(importe - total),
    total,
    base_sin_iva: base,
    iva,
    netos: netosCent.map((c) => (c === null ? null : c / 100)),
    sin_precio: centavos.filter((c) => c === null).length,
  };
}
