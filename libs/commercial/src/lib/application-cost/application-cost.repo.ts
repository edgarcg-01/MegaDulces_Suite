import type { Knex } from 'knex';
import type {
  AplicacionCosto, DecisionCostoGuardada, GuardarDecisionCostoDto, RenglonCostoConDecision,
} from '@megadulces/contracts/http/application-cost';
import { maximoReclamable, redondear2, validarDecision, yaDecididoAntes } from './application-cost.domain';

/**
 * `[PQ.157]` C2 — lectura y escritura de la decisión de costo. Cada función recibe la transacción con el tenant ya
 * puesto (`TenantKnexService.run`), así la RLS de producción aplica igual aquí que en la prueba contra base real.
 *
 * La verdad del renglón la da la vista `commercial.v_application_line_cost` (C0): el servidor la lee SIEMPRE al
 * decidir, y la foto que se guarda sale de ahí, nunca de lo que mandó la pantalla.
 */

export class CostoAplicadoError extends Error {
  constructor(readonly tipo: 'no_encontrado' | 'invalida' | 'conflicto', mensaje: string) {
    super(mensaje);
  }
}

export interface Quien {
  userId: string;
  username: string | null;
}

const VISTA = 'commercial.v_application_line_cost';
const TABLA = 'commercial.application_cost_decisions';

/**
 * El renglón de la vista en la forma del contrato. Se filtra por las columnas CRUDAS (`sucursal`, `folio`, y
 * `subtipo`/`renglon` como numeric): así el filtro baja hasta la llave de `kdm1`/`kdm2` (medido en prod: 25 ms por
 * aplicación). Envolverlas en `btrim` obligaría a calcular la vista entera.
 */
const COLUMNAS_RENGLON = `
  v.sucursal, v.subtipo::text AS subtipo, v.folio, v.renglon::int AS renglon,
  to_char(v.fecha_aplicacion, 'YYYY-MM-DD') AS fecha_aplicacion,
  v.proveedor_code AS supplier_code, v.sku, v.unidad AS unit,
  v.cantidad::float8 AS quantity, v.precio_aplicacion::float8 AS applied_price,
  v.precio_oc_equivalente::float8 AS oc_price, v.precio_oc::float8 AS oc_price_original,
  v.estado_costo AS cost_state, v.escala, v.factor_escala::float8 AS factor_escala,
  v.variacion_pct::float8 AS variacion_pct, v.pesos_vs_oc::float8 AS pesos_vs_oc,
  btrim(v.oe_folio) AS oe_folio, btrim(v.vale_folio) AS vale_folio, btrim(v.oc_folio) AS oc_folio,
  coalesce(v.oc_de_la_suite, false) AS oc_de_la_suite`;

type RenglonVista = Omit<RenglonCostoConDecision, 'maximo_reclamable' | 'decision' | 'antecedente'>;

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const COLUMNAS_DECISION = `
  d.id, d.sucursal, d.subtipo, d.folio, d.renglon, d.supplier_code, d.sku, d.unit,
  d.quantity::float8 AS quantity, d.applied_price::float8 AS applied_price, d.oc_price::float8 AS oc_price,
  d.cost_state, d.decision, d.reason, d.claim_amount::float8 AS claim_amount,
  to_char(d.valid_until, 'YYYY-MM-DD') AS valid_until,
  d.created_by, ${ISO('d.created_at')} AS created_at, d.superseded_by, ${ISO('d.superseded_at')} AS superseded_at`;

const llave = (r: { sucursal: string; subtipo: string; folio: string; renglon: number }) =>
  `${r.sucursal.trim()}|${String(r.subtipo).trim()}|${r.folio.trim()}|${r.renglon}`;

/** Los renglones de una aplicación `X-A-20`, con su decisión viva y su antecedente («ya se aceptó antes»). */
export async function leerAplicacion(trx: Knex.Transaction, tenant: string, sucursal: string, folio: string): Promise<AplicacionCosto> {
  const { rows } = await trx.raw(
    `SELECT ${COLUMNAS_RENGLON} FROM ${VISTA} v
      WHERE v.tenant_id = ? AND v.sucursal = ? AND v.folio = ?
      ORDER BY v.subtipo, v.renglon`,
    [tenant, sucursal, folio],
  );
  const renglones = rows as RenglonVista[];
  if (!renglones.length) throw new CostoAplicadoError('no_encontrado', `No hay aplicación ${folio} en la sucursal ${sucursal}.`);

  const { rows: vivas } = await trx.raw(
    `SELECT ${COLUMNAS_DECISION} FROM ${TABLA} d
      WHERE d.tenant_id = ? AND d.sucursal = ? AND d.folio = ? AND d.superseded_at IS NULL`,
    [tenant, sucursal, folio],
  );
  const porRenglon = new Map((vivas as DecisionCostoGuardada[]).map((d) => [llave(d), d]));

  // Los antecedentes: lo aceptado (o en promoción) del mismo proveedor y producto, en cualquier otro renglón.
  const decidibles = renglones.filter((r) => r.cost_state === 'sube' || r.cost_state === 'baja');
  let previas: DecisionCostoGuardada[] = [];
  if (decidibles.length) {
    const { rows: p } = await trx.raw(
      `SELECT ${COLUMNAS_DECISION} FROM ${TABLA} d
        WHERE d.tenant_id = ? AND d.superseded_at IS NULL AND d.decision IN ('accept', 'promotion')
          AND d.supplier_code = ANY(?) AND d.sku = ANY(?)
        ORDER BY d.created_at DESC`,
      [tenant, [...new Set(decidibles.map((r) => r.supplier_code))], [...new Set(decidibles.map((r) => r.sku))]],
    );
    previas = p as DecisionCostoGuardada[];
  }

  const salida: RenglonCostoConDecision[] = renglones.map((r) => {
    const decidible = r.cost_state === 'sube' || r.cost_state === 'baja';
    return {
      ...r,
      maximo_reclamable: maximoReclamable(r),
      decision: porRenglon.get(llave(r)) ?? null,
      antecedente: decidible ? yaDecididoAntes(previas, r) : null,
    };
  });
  return {
    sucursal,
    folio,
    renglones: salida,
    por_decidir: salida.filter((r) => (r.cost_state === 'sube' || r.cost_state === 'baja') && !r.decision).length,
  };
}

/**
 * Guarda la decisión de un renglón. La foto sale de la vista (no de la pantalla); si ya había una decisión viva, se
 * reemplaza en la misma transacción (`superseded_*`) y nada se borra. Dos personas a la vez: la segunda choca con el
 * índice único de la decisión viva y recibe un conflicto, no una decisión duplicada.
 */
export async function guardarDecision(trx: Knex.Transaction, tenant: string, quien: Quien, dto: GuardarDecisionCostoDto): Promise<DecisionCostoGuardada> {
  const { rows } = await trx.raw(
    `SELECT ${COLUMNAS_RENGLON} FROM ${VISTA} v
      WHERE v.tenant_id = ? AND v.sucursal = ? AND v.folio = ? AND v.subtipo = ?::numeric AND v.renglon = ?::numeric`,
    [tenant, dto.sucursal, dto.folio, dto.subtipo, dto.renglon],
  );
  const r = rows[0] as RenglonVista | undefined;
  if (!r) throw new CostoAplicadoError('no_encontrado', `No hay renglón ${dto.renglon} en la aplicación ${dto.folio} de la sucursal ${dto.sucursal}.`);

  const errores = validarDecision(r, dto);
  if (errores.length) throw new CostoAplicadoError('invalida', errores.join(' '));

  const autor = (quien.username ?? '').trim() || quien.userId;
  const viva = await trx(TABLA)
    .where({ tenant_id: tenant, sucursal: r.sucursal, subtipo: r.subtipo, folio: r.folio, renglon: r.renglon })
    .whereNull('superseded_at')
    .forUpdate()
    .first('id');
  if (viva) {
    await trx(TABLA).where({ id: viva.id }).update({
      superseded_by: autor, superseded_at: trx.fn.now(), updated_by: autor, updated_at: trx.fn.now(),
    });
  }
  try {
    const [nueva] = await trx(TABLA).insert({
      tenant_id: tenant,
      sucursal: r.sucursal, subtipo: r.subtipo, folio: r.folio, renglon: r.renglon,
      supplier_code: r.supplier_code, sku: r.sku, unit: r.unit,
      quantity: r.quantity, applied_price: r.applied_price, oc_price: r.oc_price,
      cost_state: r.cost_state, decision: dto.decision, reason: dto.reason.trim(),
      claim_amount: dto.decision === 'claim' ? redondear2(Number(dto.claim_amount)) : null,
      valid_until: dto.decision === 'promotion' ? dto.valid_until : null,
      created_by: autor, updated_by: autor,
    }).returning('id');
    const { rows: [guardada] } = await trx.raw(`SELECT ${COLUMNAS_DECISION} FROM ${TABLA} d WHERE d.id = ?`, [nueva.id]);
    return guardada as DecisionCostoGuardada;
  } catch (e) {
    const codigo = (e as { code?: string })?.code;
    if (codigo === '23505') {
      throw new CostoAplicadoError('conflicto', 'Otra persona acaba de decidir este renglón: vuelve a abrir la aplicación para ver su decisión.');
    }
    // Red de seguridad: si la base rechaza la fila por una regla (CHECK o NOT NULL) que el dominio no vio, es un 400
    // con su motivo, no un 500. El dominio repite las reglas; esto cubre la que se le escape (revisión del PR).
    if (codigo === '23514' || codigo === '23502') {
      throw new CostoAplicadoError('invalida', 'La base no aceptó la decisión: revisa el monto, la fecha y el motivo.');
    }
    throw e;
  }
}
