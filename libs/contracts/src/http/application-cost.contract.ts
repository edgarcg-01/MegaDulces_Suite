/**
 * `[PQ.157]` Compras › validar el costo al aplicar — el vocabulario de la decisión por renglón.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_RECEPCION_EN_KEPLER.md` §3d y §3e.
 * Tabla: `commercial.application_cost_decisions` (mig 20261126001925). Sus CHECK aceptan EXACTAMENTE las listas de
 * este archivo: lo vigila `database/tests/test-newdb-pq157-decisions.js`. Si agregas un valor aquí, agrégalo también
 * al CHECK con una migración, o la pantalla ofrecerá algo que la base rechaza.
 *
 * Tipos, constantes y las reglas PURAS de la decisión (al final): las usan la API (`libs/commercial`) y la pantalla, para
 * que el tope del reclamo y los textos de error sean los mismos en los dos lados. No lee el reloj ni la base.
 */

/**
 * Lo que Compras decide sobre un renglón aplicado a otro costo que el de su OC (Francisco, 2026-11-26):
 *  - `accept`: el costo nuevo se acepta; la OC siguiente nace con él y, si el margen cambia, se avisa a precios.
 *  - `claim`: se reclama al proveedor una nota de crédito por la diferencia. Sólo cuando el costo SUBE.
 *  - `promotion`: precio de promoción o temporal, con fecha de fin; la OC siguiente no lo hereda.
 */
export type DecisionCosto = 'accept' | 'claim' | 'promotion';
export const DECISIONES_COSTO: readonly DecisionCosto[] = ['accept', 'claim', 'promotion'];

export const ETIQUETA_DECISION_COSTO: Readonly<Record<DecisionCosto, string>> = {
  accept: 'Aceptar el costo',
  claim: 'Reclamar nota de crédito',
  promotion: 'Promoción temporal',
};

/** Los estados de `commercial.v_application_line_cost` sobre los que se decide: sólo lo que difiere de la OC. */
export type EstadoCostoDecidible = 'sube' | 'baja';
export const ESTADOS_COSTO_DECIDIBLES: readonly EstadoCostoDecidible[] = ['sube', 'baja'];

/**
 * El renglón de aplicación tal como lo ve quien decide (una fila de `commercial.v_application_line_cost`).
 * `oc_price` es el precio de la OC ya llevado a la unidad de la aplicación (`precio_oc_equivalente`).
 */
export interface RenglonCostoAplicado {
  sucursal: string;
  subtipo: string;
  folio: string;
  renglon: number;
  /** Fecha de la aplicación, `YYYY-MM-DD`. */
  fecha_aplicacion: string;
  supplier_code: string;
  sku: string;
  unit: string | null;
  quantity: number;
  applied_price: number;
  oc_price: number | null;
  /** El estado de la vista: `igual`, `sube`, `baja`, `sin_oc`, `sin_precio`, `otra_escala_sin_factor`, `otra_escala_ambigua`. */
  cost_state: string;
}

/** Lo que manda la pantalla al decidir. */
export interface NuevaDecisionCosto {
  decision: DecisionCosto;
  /** Por qué, en palabras de quien decide (10 letras o más). */
  reason: string;
  /** Sólo en `claim`: lo que se espera de la nota, en pesos; nunca más que la diferencia contra la OC. */
  claim_amount?: number | null;
  /** Sólo en `promotion`: hasta cuándo vale el precio, `YYYY-MM-DD`. */
  valid_until?: string | null;
}

/** Lo que manda la pantalla al decidir un renglón: su llave de Kepler y la decisión. El resto lo lee el servidor. */
export interface GuardarDecisionCostoDto extends NuevaDecisionCosto {
  sucursal: string;
  subtipo: string;
  folio: string;
  renglon: number;
}

/** Un renglón de la aplicación con su cadena, su decisión viva y su antecedente. */
export interface RenglonCostoConDecision extends RenglonCostoAplicado {
  /** El precio de la OC tal como está en la OC (antes de llevarlo a la unidad de la aplicación). */
  oc_price_original: number | null;
  /** `misma` · `oc_en_unidad_mayor` · `aplicacion_en_unidad_mayor` (la OC en caja aplicada por pieza, o al revés). */
  escala: string | null;
  factor_escala: number | null;
  /** (aplicado ÷ OC − 1), en porcentaje; `null` si no hay OC comparable. */
  variacion_pct: number | null;
  /** (aplicado − OC) × cantidad, en pesos. */
  pesos_vs_oc: number | null;
  /** La cadena hacia atrás: la orden de entrada, el vale y la OC de donde salió el renglón. */
  oe_folio: string | null;
  vale_folio: string | null;
  oc_folio: string | null;
  oc_de_la_suite: boolean;
  /** Lo más que se puede reclamar en este renglón (0 si no subió). */
  maximo_reclamable: number;
  /** La decisión viva sobre este renglón, si ya la hay. */
  decision: DecisionCostoGuardada | null;
  /** «Ya se aceptó antes»: otra decisión viva del mismo proveedor, producto y unidad con el mismo costo. */
  antecedente: DecisionCostoGuardada | null;
}

/** Los renglones de una aplicación `X-A-20` (lo que abre el panel de Revisión de facturas). */
export interface AplicacionCosto {
  sucursal: string;
  folio: string;
  renglones: RenglonCostoConDecision[];
  /** Renglones que difieren de su OC y todavía no tienen decisión. */
  por_decidir: number;
}

/** Una decisión guardada (viva o reemplazada). */
export interface DecisionCostoGuardada extends NuevaDecisionCosto {
  id: string;
  sucursal: string;
  subtipo: string;
  folio: string;
  renglon: number;
  supplier_code: string;
  sku: string;
  unit: string | null;
  quantity: number;
  applied_price: number;
  oc_price: number;
  cost_state: EstadoCostoDecidible;
  created_by: string;
  /** ISO 8601. */
  created_at: string;
  superseded_by: string | null;
  superseded_at: string | null;
}

// ── Las reglas puras ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `[PQ.157]` C1 — las reglas de la decisión de costo por renglón, sin base ni reloj.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_RECEPCION_EN_KEPLER.md` §3d–§3e. La tabla es
 * `commercial.application_cost_decisions` (mig 20261126001925); sus CHECK repiten las reglas duras de aquí para que
 * ni un camino que se salte el dominio meta una decisión imposible. Lo que sólo vive aquí: los textos para la
 * persona, la fecha de la promoción contra la de la aplicación, y «ya se aceptó antes».
 */

/**
 * «Igual» de la vista C0: a un centavo o a 0.5 %. Son los `CENTAVO` y `TOL` de la migración 20261125214023;
 * `database/tests/test-newdb-pq157-decisions.js` falla si se separan.
 */
export const CENTAVO_COSTO = 0.01;
export const TOL_COSTO = 0.005;
/** El motivo mínimo, en letras (el CHECK de la tabla pide lo mismo). */
export const MOTIVO_MINIMO = 10;
/** Holgura del monto reclamado contra la diferencia: el redondeo de la base y el de JavaScript difieren en un centavo. */
const HOLGURA_RECLAMO = 0.01;
const EPS = 1e-9;

export const redondear2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/** ¿Dos costos son el mismo para Compras? El corte de la vista: a un centavo o a 0.5 %. */
export function mismoCosto(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) <= CENTAVO_COSTO + EPS || Math.abs(a / b - 1) <= TOL_COSTO + EPS;
}

/** Como lo guarda la tabla: cantidad `numeric(16,4)` y precios `numeric(16,6)`. El tope tiene que salir del MISMO dato
 *  que lee el CHECK, o una cantidad en KG con 5 decimales pasaría aquí y la base la rechazaría (revisión del PR). */
const comoGuarda = (x: number, decimales: number): number => Math.round((x + Number.EPSILON) * 10 ** decimales) / 10 ** decimales;

/** Lo más que se puede reclamar de un renglón: la diferencia contra la OC por la cantidad. Cero si no subió. */
export function maximoReclamable(r: Pick<RenglonCostoAplicado, 'cost_state' | 'applied_price' | 'oc_price' | 'quantity'>): number {
  if (r.cost_state !== 'sube' || r.oc_price == null) return 0;
  return redondear2((comoGuarda(r.applied_price, 6) - comoGuarda(r.oc_price, 6)) * comoGuarda(r.quantity, 4));
}

/** Letras como las cuenta Postgres (`length`): por carácter, no por unidad UTF-16 (un emoji son dos aquí y uno allá). */
const letras = (s: string | null | undefined): number => [...(s ?? '').trim()].length;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fechaValida = (s: string | null | undefined): s is string =>
  typeof s === 'string' && FECHA.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * Lo que impide guardar una decisión, en palabras para quien la toma. Vacío = se puede guardar.
 * Las mismas reglas que los CHECK, más las que la base no puede ver (la fecha de la aplicación).
 */
export function validarDecision(r: RenglonCostoAplicado, d: NuevaDecisionCosto): string[] {
  const e: string[] = [];
  if (!(ESTADOS_COSTO_DECIDIBLES as readonly string[]).includes(r.cost_state) || r.oc_price == null) {
    e.push('Este renglón no difiere de su OC (o no tiene OC): no hay nada que decidir.');
    return e;
  }
  if (!(DECISIONES_COSTO as readonly string[]).includes(d.decision)) {
    e.push(`Decisión desconocida: «${String(d.decision)}».`);
    return e;
  }
  // La tabla pide cantidad y precios mayores que cero (como los guarda): sin eso, la base rechazaría cualquier decisión.
  if (!(comoGuarda(r.quantity, 4) > 0) || !(comoGuarda(r.applied_price, 6) > 0) || !(comoGuarda(r.oc_price, 6) > 0)) {
    e.push('El renglón no tiene cantidad o precio en Kepler: no se puede decidir.');
    return e;
  }
  if (letras(d.reason) < MOTIVO_MINIMO) e.push(`Escribe por qué, con al menos ${MOTIVO_MINIMO} letras.`);

  if (d.decision === 'claim') {
    const max = maximoReclamable(r);
    if (r.cost_state !== 'sube') e.push('Sólo se reclama cuando el costo sube: si bajó, no hay nota que pedir.');
    // Se juzga el monto como se va a guardar (al centavo): 0.004 se guarda como 0.00.
    else if (typeof d.claim_amount !== 'number' || !Number.isFinite(d.claim_amount) || redondear2(d.claim_amount) <= 0) {
      e.push('Di cuánto esperas de la nota de crédito.');
    } else if (redondear2(d.claim_amount) > max + HOLGURA_RECLAMO) {
      e.push(`No se puede reclamar más que la diferencia contra la OC ($${max.toFixed(2)}).`);
    }
  } else if (d.claim_amount != null) {
    e.push('El monto de la nota sólo va al reclamar.');
  }

  if (d.decision === 'promotion') {
    if (!fechaValida(d.valid_until)) e.push('Di hasta cuándo vale la promoción.');
    else if (d.valid_until < r.fecha_aplicacion) e.push('La promoción tiene que seguir vigente el día de la aplicación.');
  } else if (d.valid_until != null) {
    e.push('La fecha de fin sólo va en una promoción.');
  }
  return e;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
const mismoRenglon = (a: Pick<RenglonCostoAplicado, 'sucursal' | 'subtipo' | 'folio' | 'renglon'>, b: typeof a) =>
  norm(a.sucursal) === norm(b.sucursal) && norm(a.subtipo) === norm(b.subtipo) && norm(a.folio) === norm(b.folio) && a.renglon === b.renglon;

/**
 * «Ya se aceptó antes»: la decisión viva más reciente, de OTRO renglón, que ya aceptó este mismo costo para el
 * mismo proveedor, producto y unidad (o una promoción con ese costo, vigente el día de esta aplicación).
 * El 56 % de lo que Compras corrige ya era el precio de la aplicación anterior (anexo R §3d.5): esto es lo que se
 * le dice para que no lo vuelva a pelear. `null` = no hay antecedente.
 */
export function yaDecididoAntes(previas: readonly DecisionCostoGuardada[], r: RenglonCostoAplicado): DecisionCostoGuardada | null {
  const candidatas = previas.filter((p) =>
    p.superseded_at == null
    && (p.decision === 'accept' || (p.decision === 'promotion' && p.valid_until != null && p.valid_until >= r.fecha_aplicacion))
    && norm(p.supplier_code) === norm(r.supplier_code)
    && norm(p.sku) === norm(r.sku)
    && norm(p.unit) === norm(r.unit)
    && !mismoRenglon(p, r)
    && mismoCosto(p.applied_price, r.applied_price));
  if (!candidatas.length) return null;
  return [...candidatas].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}
