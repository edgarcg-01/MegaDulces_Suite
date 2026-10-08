/**
 * `[RD.50]` — Los totales de una corrida de comisiones, como **lógica pura**.
 *
 * ── Por qué vive afuera del servicio ─────────────────────────────────────────────────────
 * Cada clave que esta función devuelve termina, tal cual, como **columna** de
 * `commercial.commission_runs`: `persist()` hace `...totals` dentro del `INSERT`. Esa
 * correspondencia no la vigilaba nadie, y el 2026-10-08 se midió el costo: `dias_multifuente`
 * salía de acá y no existía como columna, así que **el motor falló el 100 % de las veces desde
 * `c4dff2b04` y `commission_runs` nunca tuvo una sola fila** (`42703`, 20 de 20 quincenas,
 * 4 min 09 s de espera por cada intento).
 *
 * ⛔ El candado de `commission-inmutable.spec.ts` no podía verlo: llama a `persist()` con `{}`
 * como totales y sobre **dobles de knex, que no ejecutan SQL** — el propio archivo lo advierte
 * en su línea 17. Un doble nunca va a devolver un `42703`.
 *
 * ⭐ Por eso esto es un módulo **sin Nest y sin alias de ruta**: `ts-node` lo carga directo y
 * `database/tests/test-newdb-rd-commission-persist.js` compara `Object.keys(totalesDeCorrida())`
 * contra las columnas REALES de la tabla. El candado lee esta función, no una copia suya: una
 * copia se desincroniza y el test se queda verde midiendo código que ya nadie corre.
 *
 * ⚠️ Si agregás una clave acá, la tabla necesita su columna **en la misma entrega**.
 */

/** Redondeo a centavos. Mismo criterio que el resto del motor. */
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Lo mínimo que esta función lee de una línea. La `CommissionLine` real lo satisface. */
export interface LineaParaTotales {
  beneficiario: 'chofer' | 'supervisor';
  route_code: string;
  motivo_no_pago: string | null;
  subtotal: number | null;
  venta: number | null;
  comision: number;
  a_pagar: number;
  dias_multifuente: number;
}

/** Lo mínimo que esta función lee del universo. */
export interface RutaParaTotales { route_code: string; comisiona: boolean }

/** Lo mínimo que esta función lee de un beneficiario. */
export interface BeneficiarioParaTotales { deduccion: number }

export interface TotalesDeCorrida {
  total_subtotal: number;
  total_venta: number;
  total_comision: number;
  /** Bruto. Se conserva el nombre porque lo leen `v_rd_period_summary` y la pantalla. */
  total_a_pagar: number;
  total_deduccion: number;
  /** ⭐ Lo que de verdad sale del banco. */
  total_neto: number;
  /** Días del periodo alimentados por más de una captura. NO es duplicado: es el corte de sistema. */
  dias_multifuente: number;
  rutas_con_dato: number;
  rutas_sin_dato: number;
  rutas_fuera: number;
}

/**
 * ⚠️ El universo de la SUMA no es el de las lineas pagables. Una ruta bajo el umbral
 * **vendio** -- su subtotal cuenta para el total del periodo y su traslape tambien -- pero no
 * paga. Y las rutas que no comisionan no entran en ninguna de las dos. Contarlo con
 * `lines.filter(l => !l.motivo_no_pago)` metia a las de `bajo_umbral` en `rutas_sin_dato`,
 * que es un hueco de fuente y no una venta chica: dos cosas distintas con el mismo nombre.
 */
export function totalesDeCorrida(
  lines: LineaParaTotales[], universo: RutaParaTotales[],
  beneficiarios: BeneficiarioParaTotales[], fuera: unknown[],
  conDato: number, sinDato: number,
): TotalesDeCorrida {
  const comisionan = new Set(universo.filter((u) => u.comisiona).map((u) => u.route_code));
  // Lo que VENDIO: una fila por ruta que comisiona y tuvo fuente, haya pagado o no.
  const vendieron = lines.filter((l) => l.beneficiario === 'chofer'
    && comisionan.has(l.route_code) && l.motivo_no_pago !== 'sin_dato_en_la_fuente');
  // Lo que PAGA.
  const pagables = lines.filter((l) => !l.motivo_no_pago);
  const bruto = r2(pagables.reduce((s, l) => s + l.a_pagar, 0));
  const deduccion = r2(beneficiarios.reduce((s, b) => s + b.deduccion, 0));
  return {
    total_subtotal: r2(vendieron.reduce((s, l) => s + (l.subtotal ?? 0), 0)),
    total_venta: r2(vendieron.reduce((s, l) => s + (l.venta ?? 0), 0)),
    total_comision: r2(pagables.reduce((s, l) => s + l.comision, 0)),
    total_a_pagar: bruto,
    total_deduccion: deduccion,
    total_neto: r2(bruto - deduccion),
    dias_multifuente: vendieron.reduce((s, l) => s + l.dias_multifuente, 0),
    rutas_con_dato: conDato,
    rutas_sin_dato: sinDato,
    rutas_fuera: fuera.length,
  };
}
