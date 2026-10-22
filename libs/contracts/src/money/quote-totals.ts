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
 *     IVA, IEPS   por renglón, con la tasa de SU producto (`[E.25]`): el neto del renglón
 *                 (importe × (1 − %), sin redondear) se descompone en cascada —IEPS sobre la base,
 *                 IVA sobre (base + IEPS), la misma regla de los tickets (TK.13)— y se redondea
 *                 la SUMA. Así cuadra con `kdm1.c14`/`c15` de Kepler: 79 de 79 pedidos del replay.
 *     subtotal    total − IVA − IEPS
 *
 * Un renglón sin tasa registrada (cotización anterior a E.25) se calcula con IVA 16 % ASUMIDO y se
 * cuenta en `impuesto_asumido`: la pantalla y el papel lo tienen que decir (ADR-056).
 *
 * ⚠️ El descuento por volumen o promoción NO aparece acá: ya está dentro del precio unitario de
 * cada renglón. Aplicarlo otra vez fue justamente el defecto.
 *
 * Desde `[E.25]` el servidor (`recalcTotals`) llama a ESTA función: ya no hay una segunda cuenta.
 */

/** IVA que se ASUME para un renglón sin tasa registrada (anterior a E.25). Se declara, no se esconde. */
export const QUOTE_TAX_RATE = 0.16;

/** `[E.25]` Tasas del producto de un renglón, como fracción (0.16, 0.08). null = no se registró. */
export interface QuoteLineTaxRates {
  iva: number | null;
  ieps: number | null;
}

export interface QuoteTotals {
  /** Σ importes de los renglones CON precio. */
  importe: number;
  /** El % del cliente tal como está congelado; null = no hay descuento configurado. */
  descuento_pct: number | null;
  /** importe − total. Exacto por construcción. */
  descuento: number;
  total: number;
  /** total − IVA − IEPS: lo que Kepler llama Subtotal (sin impuestos, ya con el % del cliente). */
  subtotal: number;
  iva: number;
  ieps: number;
  /** Renglones con importe cuyo impuesto se ASUMIÓ (IVA 16 %) por no tener tasa registrada. */
  impuesto_asumido: number;
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
 * @param tasas     `[E.25]` IVA/IEPS de cada renglón, en el mismo orden. Ausente o null = asumido.
 */
export function totalesCotizacion(
  importes: Array<number | null>,
  pct: number | null,
  tasas?: Array<QuoteLineTaxRates | null | undefined>,
): QuoteTotals {
  const p = pct !== null && Number.isFinite(pct) && pct > 0 ? pct : null;
  // Se suma en centavos enteros: sumar flotantes de dos decimales arrastra error.
  const centavos = importes.map((x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 100)));
  const importeCent = centavos.reduce<number>((a, c) => a + (c ?? 0), 0);
  const importe = importeCent / 100;
  const total = p ? redondear2(importe * (1 - p / 100)) : redondear2(importe);

  let ivaX = 0;
  let iepsX = 0;
  let impuestoAsumido = 0;
  importes.forEach((x, i) => {
    if (x === null || !Number.isFinite(x) || x === 0) return;
    const t = tasas?.[i];
    const sinTasa = !t || (t.iva === null && t.ieps === null);
    if (sinTasa) impuestoAsumido++;
    const tIva = sinTasa ? QUOTE_TAX_RATE : (t.iva ?? 0);
    const tIeps = sinTasa ? 0 : (t.ieps ?? 0);
    const neto = x * (p ? 1 - p / 100 : 1);
    const base = neto / ((1 + tIeps) * (1 + tIva));
    iepsX += base * tIeps;
    ivaX += base * (1 + tIeps) * tIva;
  });
  const iva = redondear2(ivaX);
  const ieps = redondear2(iepsX);

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
    subtotal: redondear2(total - iva - ieps),
    iva,
    ieps,
    impuesto_asumido: impuestoAsumido,
    netos: netosCent.map((c) => (c === null ? null : c / 100)),
    sin_precio: centavos.filter((c) => c === null).length,
  };
}
