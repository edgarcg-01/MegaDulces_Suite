/**
 * [GX.19] Cobertura declarada de `/finanzas/egresos` — qué parte del número es COMPARABLE.
 *
 * ── EL PROBLEMA MEDIDO (prod, 2026-09-25) ────────────────────────────────────────────────
 * El universo de sucursales de `analytics.expense_entries` **crece mes a mes**: 2025-08→11 sólo la
 * `00`; `02` entra en 2025-12; `03` en 2026-01; `04` en 02; `05` en 03; `01` en 06; `06` en 08;
 * `07` y `08` en 09. Parte lo explica el cutover de ERP (`v_branch_erp_cutover`) y parte es que la
 * contabilidad por sucursal en Kepler no existe hacia atrás — verificado contra el propio ODS: en
 * `kepler_ods.kdc22510` sólo hay sucursal `00`.
 *
 * Con el rango por defecto (90 d) eso hacía que la pantalla publicara:
 *
 *      Δ vs período previo con TODAS las sucursales ...... +27.0 %
 *      Δ con las sucursales presentes en AMBOS ............  +1.1 %
 *
 * O sea: **26 de los 27 puntos eran sucursales entrando al universo, no gasto**. Y la gráfica de
 * tendencia corta los dos meses de las puntas (jun desde el día 27, sep hasta el 25), lo que dibuja
 * un auge y un desplome que son el calendario.
 *
 * ── LA REGLA ─────────────────────────────────────────────────────────────────────────────
 * ADR-056: lo que no se puede medir se DECLARA. Acá SÍ se puede medir, así que se mide y se dice.
 * Nada se filtra ni se corrige por lo bajo — el total sigue siendo el total, que es lo que cuadra
 * contra la balanza (`analytics.ledger_monthly`: familia 6 y 7 coinciden al centavo). Lo que se
 * agrega es el **segundo número** y el motivo, para que nadie lea universo como desempeño.
 *
 * Es lógica pura a propósito (sin `trx`, sin fechas de reloj): así se prueba, y el patrón ya existe
 * al lado en `route-sales-pace.ts`.
 */

/**
 * [GX.19] Filtros del reporte de egresos. Vive con la lógica pura (no en `libs/contracts`) porque
 * no es forma de wire: el controller recibe los parámetros sueltos y los arma con
 * `parseExpenseFilters`. Los `*_null` son el drill del bucket "(sin …)" y los `*_eq` el drill
 * exacto desde una fila.
 */
export interface ExpenseQueryFilters {
  sucursal?: string[];
  familia?: string;
  doc_tipo?: string;
  cuenta?: string;
  cuenta_mayor?: string;
  area?: string;
  area_null?: boolean;
  dpto?: string;
  dpto_null?: boolean;
  concepto?: string;
  concepto_null?: boolean;
  beneficiario?: string;
  beneficiario_eq?: string;
  beneficiario_null?: boolean;
  min_importe?: number;
  max_importe?: number;
  from?: string;
  to?: string;
  group_by?: string;
  compare?: boolean;
}

/** Un renglón agregado (mes × sucursal) del período. */
export interface ExpenseMonthBranch {
  mes: string;      // 'YYYY-MM'
  sucursal: string;
  total: number;
}

export interface ExpenseCoverage {
  /** Si la medición pudo hacerse. `false` → `pct` es null y nada se afirma. */
  measured: boolean;
  /** % del total del rango que aportan las sucursales presentes en TODOS sus meses. */
  pct: number | null;
  /** En palabras accionables: qué quedó afuera de la comparación y por qué. */
  note: string;
  /** Todas las sucursales con movimiento en el rango. */
  sucursales: string[];
  /** Las que están en TODOS los meses del rango (el núcleo comparable mes a mes). */
  sucursales_todos: string[];
  /** Las que entran o salen a mitad del rango, con el mes en que aparecen por primera vez. */
  sucursales_parciales: Array<{ sucursal: string; desde: string; total: number }>;
  /** Meses que el rango corta (no entran completos) — las puntas de la gráfica. */
  meses_parciales: string[];
}

export interface ExpenseComparativo {
  sucursales_ambos: string[];
  /** Entraron al universo: están en el actual y no en el previo. */
  solo_actual: string[];
  /** Dejaron de reportar: estaban en el previo y no en el actual. */
  solo_previo: string[];
  total: number;
  total_prev: number;
  delta_pct: number | null;
  total_comparable: number;
  total_prev_comparable: number;
  delta_pct_comparable: number | null;
  /** `true` cuando el universo cambió → el Δ de arriba NO es sólo gasto. */
  universo_cambio: boolean;
}

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const r1 = (v: number) => Math.round((v + Number.EPSILON) * 10) / 10;

/** Δ% con la única salida honesta cuando la base es 0: `null`, nunca 0 ni Infinity. */
export function deltaPct(actual: number, previo: number): number | null {
  return previo > 0 ? r1(((actual - previo) / previo) * 100) : null;
}

/** Primer día del mes de una fecha `YYYY-MM-DD`. */
const primerDia = (mes: string) => `${mes}-01`;

/**
 * Último día del mes `YYYY-MM`, sin `Date` (evita que UTC-6 corra el día — la misma trampa que el
 * frontend ya esquiva formateando en local).
 */
export function ultimoDiaMes(mes: string): string {
  const y = Number(mes.slice(0, 4));
  const m = Number(mes.slice(5, 7));
  const bisiesto = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dias = [31, bisiesto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return `${mes}-${String(dias).padStart(2, '0')}`;
}

/**
 * Meses del rango que el propio rango corta. Un mes es parcial si `from` cae después de su día 1 o
 * `to` antes de su último día — típicamente las dos puntas, y **siempre** el mes en curso.
 */
export function mesesParciales(meses: string[], from: string, to: string): string[] {
  return meses.filter((m) => from > primerDia(m) || to < ultimoDiaMes(m));
}

/**
 * Cobertura del rango: qué sucursales están en todos sus meses y cuánto pesa lo que no.
 *
 * ⚠️ `pct` mide el **núcleo comparable**, no "cuánto dato hay". Con una sola sucursal en todos los
 * meses y otra que entra a mitad, `pct` baja aunque el total esté completo: es exactamente lo que
 * hay que decir antes de leer una tendencia.
 */
export function computeExpenseCoverage(
  filas: ExpenseMonthBranch[], from: string, to: string,
): ExpenseCoverage {
  if (!filas.length) {
    return {
      measured: false, pct: null,
      note: 'Sin movimientos en el período — no hay cobertura que medir.',
      sucursales: [], sucursales_todos: [], sucursales_parciales: [], meses_parciales: [],
    };
  }

  const meses = [...new Set(filas.map((f) => f.mes))].sort();
  const sucursales = [...new Set(filas.map((f) => f.sucursal))].sort();

  const porSucursal = new Map<string, { meses: Set<string>; total: number; desde: string }>();
  for (const f of filas) {
    const cur = porSucursal.get(f.sucursal) ?? { meses: new Set<string>(), total: 0, desde: f.mes };
    cur.meses.add(f.mes);
    cur.total += f.total;
    if (f.mes < cur.desde) cur.desde = f.mes;
    porSucursal.set(f.sucursal, cur);
  }

  const todos = sucursales.filter((s) => porSucursal.get(s)!.meses.size === meses.length);
  const parciales = sucursales
    .filter((s) => !todos.includes(s))
    .map((s) => ({ sucursal: s, desde: porSucursal.get(s)!.desde, total: r2(porSucursal.get(s)!.total) }))
    .sort((a, b) => b.total - a.total);

  const total = filas.reduce((a, f) => a + f.total, 0);
  const totalNucleo = todos.reduce((a, s) => a + porSucursal.get(s)!.total, 0);
  const parcialesMes = mesesParciales(meses, from, to);

  const partes: string[] = [];
  if (parciales.length) {
    const nom = parciales.map((p) => `${p.sucursal} (desde ${p.desde})`).join(', ');
    partes.push(
      `${parciales.length} sucursal${parciales.length > 1 ? 'es' : ''} no está${parciales.length > 1 ? 'n' : ''} en todos los meses del rango: ${nom}. ` +
      `Aporta${parciales.length > 1 ? 'n' : ''} ${r2(total - totalNucleo).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} — ` +
      `ese monto sube el total sin que nadie haya gastado más.`,
    );
  }
  if (parcialesMes.length) {
    partes.push(
      `Mes${parcialesMes.length > 1 ? 'es' : ''} incompleto${parcialesMes.length > 1 ? 's' : ''} en la tendencia: ${parcialesMes.join(', ')} — ` +
      `el rango los corta, así que su barra es más baja por calendario, no por gasto.`,
    );
  }
  if (!partes.length) partes.push('Las mismas sucursales reportan en todos los meses del rango y ningún mes queda cortado: la tendencia es comparable.');

  return {
    measured: true,
    pct: total > 0 ? r1((totalNucleo / total) * 100) : null,
    note: partes.join(' '),
    sucursales,
    sucursales_todos: todos,
    sucursales_parciales: parciales,
    meses_parciales: parcialesMes,
  };
}

/**
 * Comparativo contra el período previo, con y sin las sucursales que cambiaron de universo.
 *
 * El Δ de TODAS se sigue publicando —es el movimiento real de la caja— pero al lado va el Δ del
 * conjunto que existe en los dos períodos, que es el único que responde "¿gastamos más?".
 */
export function computeExpenseComparativo(
  actual: ExpenseMonthBranch[], previo: ExpenseMonthBranch[],
): ExpenseComparativo {
  const sum = (filas: ExpenseMonthBranch[], filtro?: (s: string) => boolean) =>
    filas.reduce((a, f) => (!filtro || filtro(f.sucursal) ? a + f.total : a), 0);

  const sucA = new Set(actual.map((f) => f.sucursal));
  const sucP = new Set(previo.map((f) => f.sucursal));
  const ambos = [...sucA].filter((s) => sucP.has(s)).sort();
  const enAmbos = (s: string) => sucA.has(s) && sucP.has(s);

  const total = sum(actual);
  const totalPrev = sum(previo);
  const comparable = sum(actual, enAmbos);
  const comparablePrev = sum(previo, enAmbos);

  return {
    sucursales_ambos: ambos,
    solo_actual: [...sucA].filter((s) => !sucP.has(s)).sort(),
    solo_previo: [...sucP].filter((s) => !sucA.has(s)).sort(),
    total: r2(total),
    total_prev: r2(totalPrev),
    delta_pct: deltaPct(total, totalPrev),
    total_comparable: r2(comparable),
    total_prev_comparable: r2(comparablePrev),
    delta_pct_comparable: deltaPct(comparable, comparablePrev),
    universo_cambio: ambos.length !== sucA.size || ambos.length !== sucP.size,
  };
}
