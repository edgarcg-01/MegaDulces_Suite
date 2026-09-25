/**
 * `[GX.19]` / `[IG.1]` Cobertura declarada de un reporte por período — **qué parte del número es
 * COMPARABLE**.
 *
 * ── EL PROBLEMA MEDIDO (prod, 2026-09-25, en `/finanzas/egresos`) ────────────────────────
 * El universo de `analytics.expense_entries` **crece mes a mes**: 2025-08→11 sólo la sucursal `00`;
 * `02` entra en 2025-12; `03` en 2026-01; `04` en 02; `05` en 03; `01` en 06; `06` en 08; `07` y
 * `08` en 09. Parte lo explica el cutover de ERP (`v_branch_erp_cutover`) y parte es que la
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
 * ── POR QUÉ SE LLAMA `period-*` Y NO `expense-*` ────────────────────────────────────────
 * Nació en `[GX.19]` como `expense-coverage.ts`. Al llegar `[IG.1]` (ingresos) resultó que el
 * mecanismo no tiene nada de gasto: agrupa filas `(mes, grupo, total)` y mide si el conjunto de
 * grupos cambia adentro del rango. Del lado del gasto el grupo es la **sucursal**; del lado del
 * ingreso es la **plaza**. Dejarlo con el nombre viejo —y con un campo `sucursal` conteniendo una
 * plaza— era exactamente la clase de mentira que esta capa existe para cortar, y ADR-056 pide que
 * un primitivo que sirve a dos dominios viva con el nombre de lo que hace.
 *
 * Por eso el texto de la nota recibe `etiqueta`: el que llama dice cómo se llama su grupo.
 *
 * ── LA REGLA ─────────────────────────────────────────────────────────────────────────────
 * ADR-056: lo que no se puede medir se DECLARA. Acá SÍ se puede medir, así que se mide y se dice.
 * Nada se filtra ni se corrige por lo bajo — el total sigue siendo el total. Lo que se agrega es el
 * **segundo número** y el motivo, para que nadie lea universo como desempeño.
 *
 * Es lógica pura a propósito (sin `trx`, sin fechas de reloj): así se prueba, y el patrón ya existe
 * al lado en `route-sales-pace.ts`.
 */

/**
 * `[IG.1]` Filtros del reporte de egresos. Vive con la lógica pura (no en `libs/contracts`) porque
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

/**
 * `[IG.1]` Filtros del reporte de INGRESOS. Mucho más corto que el de egresos a propósito: las
 * dimensiones que allá discriminan (cuenta, área, depto, beneficiario, sucursal) acá no miden nada
 * —la sucursal es siempre `00`, los campos de solicitud vienen vacíos y los nombres de las 6
 * cuentas mienten. Lo que discrimina es canal y plaza, que viven en el concepto `c6`.
 */
export interface IncomeQueryFilters {
  canal?: string[];
  plaza?: string;
  /** Búsqueda libre sobre el concepto crudo de la póliza (ahí vive el nombre del cliente). */
  concepto?: string;
  min_importe?: number;
  max_importe?: number;
  from?: string;
  to?: string;
  group_by?: string;
  compare?: boolean;
}

/** Un renglón agregado `(mes × grupo)` del período. `grupo` = sucursal en egresos, plaza en ingresos. */
export interface PeriodSlice {
  mes: string;      // 'YYYY-MM'
  grupo: string;
  total: number;
}

/** Cómo se llama el grupo en la pantalla que pregunta. */
export interface GrupoEtiqueta {
  singular: string;  // 'sucursal' · 'plaza'
  plural: string;    // 'sucursales' · 'plazas'
}

export const ETIQUETA_SUCURSAL: GrupoEtiqueta = { singular: 'sucursal', plural: 'sucursales' };
export const ETIQUETA_PLAZA: GrupoEtiqueta = { singular: 'plaza', plural: 'plazas' };

export interface PeriodCoverage {
  /** Si la medición pudo hacerse. `false` → `pct` es null y nada se afirma. */
  measured: boolean;
  /** % del total del rango que aportan los grupos presentes en TODOS sus meses. */
  pct: number | null;
  /** En palabras accionables: qué quedó afuera de la comparación y por qué. */
  note: string;
  /** Todos los grupos con movimiento en el rango. */
  grupos: string[];
  /** Los que están en TODOS los meses del rango (el núcleo comparable mes a mes). */
  grupos_todos: string[];
  /** Los que entran o salen a mitad del rango, con el mes en que aparecen por primera vez. */
  grupos_parciales: Array<{ grupo: string; desde: string; total: number }>;
  /** Meses que el rango corta (no entran completos) — las puntas de la gráfica. */
  meses_parciales: string[];
}

export interface PeriodComparativo {
  grupos_ambos: string[];
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
  /** `true` cuando el universo cambió → el Δ de arriba NO es sólo desempeño. */
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
 * Cobertura del rango: qué grupos están en todos sus meses y cuánto pesa lo que no.
 *
 * ⚠️ `pct` mide el **núcleo comparable**, no "cuánto dato hay". Con un solo grupo en todos los
 * meses y otro que entra a mitad, `pct` baja aunque el total esté completo: es exactamente lo que
 * hay que decir antes de leer una tendencia.
 */
export function computePeriodCoverage(
  filas: PeriodSlice[], from: string, to: string, etiqueta: GrupoEtiqueta = ETIQUETA_SUCURSAL,
): PeriodCoverage {
  if (!filas.length) {
    return {
      measured: false, pct: null,
      note: 'Sin movimientos en el período — no hay cobertura que medir.',
      grupos: [], grupos_todos: [], grupos_parciales: [], meses_parciales: [],
    };
  }

  const meses = [...new Set(filas.map((f) => f.mes))].sort();
  const grupos = [...new Set(filas.map((f) => f.grupo))].sort();

  const porGrupo = new Map<string, { meses: Set<string>; total: number; desde: string }>();
  for (const f of filas) {
    const cur = porGrupo.get(f.grupo) ?? { meses: new Set<string>(), total: 0, desde: f.mes };
    cur.meses.add(f.mes);
    cur.total += f.total;
    if (f.mes < cur.desde) cur.desde = f.mes;
    porGrupo.set(f.grupo, cur);
  }

  const todos = grupos.filter((g) => porGrupo.get(g)!.meses.size === meses.length);
  const parciales = grupos
    .filter((g) => !todos.includes(g))
    .map((g) => ({ grupo: g, desde: porGrupo.get(g)!.desde, total: r2(porGrupo.get(g)!.total) }))
    .sort((a, b) => b.total - a.total);

  const total = filas.reduce((a, f) => a + f.total, 0);
  const totalNucleo = todos.reduce((a, g) => a + porGrupo.get(g)!.total, 0);
  const parcialesMes = mesesParciales(meses, from, to);

  const partes: string[] = [];
  if (parciales.length) {
    const nom = parciales.map((p) => `${p.grupo} (desde ${p.desde})`).join(', ');
    const n = parciales.length;
    partes.push(
      `${n} ${n > 1 ? etiqueta.plural : etiqueta.singular} no está${n > 1 ? 'n' : ''} en todos los meses del rango: ${nom}. ` +
      `Aporta${n > 1 ? 'n' : ''} ${r2(total - totalNucleo).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} — ` +
      `ese monto mueve el total sin que haya cambiado nada del negocio que sí se puede comparar.`,
    );
  }
  if (parcialesMes.length) {
    partes.push(
      `Mes${parcialesMes.length > 1 ? 'es' : ''} incompleto${parcialesMes.length > 1 ? 's' : ''} en la tendencia: ${parcialesMes.join(', ')} — ` +
      `el rango los corta, así que su barra es más baja por calendario, no por el negocio.`,
    );
  }
  if (!partes.length) {
    partes.push(`${etiqueta.plural.charAt(0).toUpperCase()}${etiqueta.plural.slice(1)}: las mismas reportan en todos los meses del rango y ningún mes queda cortado: la tendencia es comparable.`);
  }

  return {
    measured: true,
    pct: total > 0 ? r1((totalNucleo / total) * 100) : null,
    note: partes.join(' '),
    grupos,
    grupos_todos: todos,
    grupos_parciales: parciales,
    meses_parciales: parcialesMes,
  };
}

/**
 * Comparativo contra el período previo, con y sin los grupos que cambiaron de universo.
 *
 * El Δ de TODOS se sigue publicando —es el movimiento real— pero al lado va el Δ del conjunto que
 * existe en los dos períodos, que es el único que responde "¿cambió el negocio?".
 */
export function computePeriodComparativo(
  actual: PeriodSlice[], previo: PeriodSlice[],
): PeriodComparativo {
  const sum = (filas: PeriodSlice[], filtro?: (g: string) => boolean) =>
    filas.reduce((a, f) => (!filtro || filtro(f.grupo) ? a + f.total : a), 0);

  const gA = new Set(actual.map((f) => f.grupo));
  const gP = new Set(previo.map((f) => f.grupo));
  const ambos = [...gA].filter((g) => gP.has(g)).sort();
  const enAmbos = (g: string) => gA.has(g) && gP.has(g);

  const total = sum(actual);
  const totalPrev = sum(previo);
  const comparable = sum(actual, enAmbos);
  const comparablePrev = sum(previo, enAmbos);

  return {
    grupos_ambos: ambos,
    solo_actual: [...gA].filter((g) => !gP.has(g)).sort(),
    solo_previo: [...gP].filter((g) => !gA.has(g)).sort(),
    total: r2(total),
    total_prev: r2(totalPrev),
    delta_pct: deltaPct(total, totalPrev),
    total_comparable: r2(comparable),
    total_prev_comparable: r2(comparablePrev),
    delta_pct_comparable: deltaPct(comparable, comparablePrev),
    universo_cambio: ambos.length !== gA.size || ambos.length !== gP.size,
  };
}
