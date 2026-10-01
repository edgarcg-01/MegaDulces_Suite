/**
 * `[IG.1]` La FORMA del wire de Ingresos contables (`/finanzas/ingresos`).
 *
 * Vive acá y no en cada lado por la razón de siempre (ADR-052 / ADR-056): el tipo de `Freshness`
 * nació en un dominio y **a los tres días ya estaba copiado a mano** en el frontend. Acá la forma se
 * declara una vez y un cambio es error de compilación en los dos lados, que es la garantía por la
 * que existe este paquete.
 *
 * La LÓGICA (las tres reglas duras, el clasificador de canal) no está acá: vive en
 * `analytics.income_entries_src()` — ver la migración `20260925150000`.
 */

import type { Coverage, Freshness } from './provenance.contract';

/** Dimensión de agrupación del reporte. */
export type IncomeGroupBy = 'canal' | 'plaza' | 'mes' | 'documento';

export interface IncomeCanalRow {
  canal: string;
  label: string;
  total: number;
  movs: number;
}

export interface IncomeRow {
  key: string;
  label: string;
  canal: string | null;
  total: number;
  movs: number;
  share_pct: number;
  prev_total: number | null;
  delta_pct: number | null;
}

export interface IncomeSeriesPoint {
  mes: string;
  total: number;
  mostrador: number;
  telemarketing: number;
  ruta: number;
  vecinal: number;
  contado: number;
  otro: number;
  /** El rango corta ese mes → su barra es más baja por calendario, no por venta. */
  parcial: boolean;
  /** Plazas que reportaron ese mes. Un escalón acá explica un escalón en el total. */
  plazas: number;
}

/**
 * Cobertura del período. Extiende la `Coverage` del contrato de procedencia con el detalle que la
 * pantalla necesita para poder NOMBRAR lo que quedó afuera — `measured`/`pct`/`note` solos dicen
 * que falta algo, no qué.
 *
 * `grupos` es la plaza del lado ingreso y la sucursal del lado gasto: el motor
 * (`period-coverage.ts`) es el mismo y recibe la etiqueta del que llama.
 */
export interface PeriodCoverageWire extends Coverage {
  grupos: string[];
  grupos_todos: string[];
  grupos_parciales: Array<{ grupo: string; desde: string; total: number }>;
  meses_parciales: string[];
}

/** El Δ con y sin los grupos que cambiaron de universo entre los dos períodos. */
export interface PeriodComparativoWire {
  grupos_ambos: string[];
  solo_actual: string[];
  solo_previo: string[];
  total: number;
  total_prev: number;
  delta_pct: number | null;
  total_comparable: number;
  total_prev_comparable: number;
  delta_pct_comparable: number | null;
  universo_cambio: boolean;
}

export interface IncomeReport {
  from: string;
  to: string;
  prev_from: string;
  prev_to: string;
  freshness: Freshness;
  coverage: PeriodCoverageWire;
  comparativo: PeriodComparativoWire | null;
  group_by: string;
  total: number;
  movimientos: number;
  by_canal: IncomeCanalRow[];
  rows: IncomeRow[];
  series: IncomeSeriesPoint[];
}

export interface IncomeTreeNode {
  key: string;
  label: string;
  level: string;
  total: number;
  movs: number;
  share_pct: number;
  children?: IncomeTreeNode[];
}

export interface IncomeTree {
  from: string;
  to: string;
  total: number;
  tree: IncomeTreeNode[];
}

/**
 * `[IG.3]` Una de las cuatro fuentes del mismo peso de venta.
 *
 * `monto: null` significa **NO MEDIDO**, y es distinto de `0`. `comparable: false` marca la fuente
 * que NO se resta de frente: la cobranza es lo que se cobró, no lo que se devengó, y su diferencia
 * es plazo de crédito, no faltante.
 */
export interface IncomeSourceRow {
  key: string;
  label: string;
  monto: number | null;
  delta_pct: number | null;
  comparable: boolean;
  /** ISO del último cierre del feed que produjo este número, cuando se pudo medir. */
  medido_al?: string | null;
  nota: string;
}

export interface IncomeSources {
  from: string;
  to: string;
  fuentes: IncomeSourceRow[];
}

// ─────────── `[IG.6]` Conciliación: lo VENDIDO y lo COBRADO, sin obligarlos a ser iguales ──────
//
// Pedido de Edgar: *"casar todos los ingresos a cada tienda y saber de dónde viene cada ingreso"*.
//
// ⛔ La razón de que sean DOS columnas y no una: la medición que disparó esto encontró que el
// ingreso publicado incluye **el CEDIS facturándole a sus propias tiendas** ($41.25 M de ago-2026,
// 73.8 % del doctype). Obligar a que vendido == cobrado forzaría a elegir una de las dos cifras y
// esconder la otra; acá las dos se publican y la diferencia se EXPLICA renglón por renglón.

/** Qué es el cliente de una venta. `sin_catalogo` es NO MEDIDO, no "externo por default". */
export type IncomeKind =
  | 'externo'
  | 'interno_sucursal'
  | 'interno_punto_venta'
  | 'interno_ruta'
  | 'interno_traspaso'
  | 'interno_telemarketing'
  | 'sin_catalogo';

/** Grano temporal del corte. */
export type IncomeGrain = 'dia' | 'mes' | 'trimestre';

/**
 * Un tramo del puente entre lo vendido y lo cobrado. `monto: null` = NO MEDIDO.
 * `resta` dice si el tramo se descuenta del vendido para llegar al cobrado, o si sólo acompaña.
 */
export interface IncomeBridgeItem {
  key: string;
  label: string;
  monto: number | null;
  resta: boolean;
  nota: string;
}

export interface IncomeReconRow {
  periodo: string;
  warehouse_code: string;
  warehouse_name: string;
  kepler_sucursal: string;
  /** Venta a cliente REAL, ya sin el envoltorio fiscal. Es el ingreso del negocio. */
  vendido_externo: number;
  /** Traspaso dentro de la casa. NO es ingreso: se publica para que se vea, no para sumarlo. */
  vendido_interno: number;
  /** Cliente que no está en `kdud`. Declarado aparte: no se cuenta como externo. */
  vendido_sin_catalogo: number;
  /** `U-D-6` Factura global: envuelve fiscalmente a los tickets `U-D-10`. Informativo. */
  envoltorio_fiscal: number;
  docs: number;
  cobrado_efectivo: number;
  cobrado_banco: number;
  /** Cobro cuya cuenta de tesorería no resuelve contra `kdb1`. NO MEDIDO, no cero. */
  cobrado_sin_cuenta: number;
  cobros: number;
  /** Cuentas distintas por las que entró dinero ese período (el "cuántos depósitos diferentes"). */
  cuentas: Array<{ code: string; nombre: string | null; medio: 'efectivo' | 'banco' | 'sin_catalogo'; cobros: number; importe: number }>;
  /** Aplicaciones cobro→factura de `kdm5`: cuántos pagos distintos se casaron, y contra cuántas facturas. */
  pagos_casados: number;
  facturas_casadas: number;
  importe_casado: number;
  /** `true` cuando el documento trae fecha posterior a hoy (Kepler lo permite). */
  tiene_fecha_futura: boolean;
}

export interface IncomeRecon {
  from: string;
  to: string;
  grain: IncomeGrain;
  freshness: Freshness;
  rows: IncomeReconRow[];
  totales: Omit<IncomeReconRow, 'periodo' | 'warehouse_code' | 'warehouse_name' | 'kepler_sucursal' | 'cuentas'>;
  bridge: IncomeBridgeItem[];
  /** Lo que esta pantalla NO puede medir, con su monto. Nunca se dibuja como cero. */
  huecos: IncomeBridgeItem[];
}
