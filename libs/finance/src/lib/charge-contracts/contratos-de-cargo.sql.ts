import type { Knex } from 'knex';
import {
  agruparPropuestas, problemasParaConfirmar, transicionPermitida,
  type CadenciaContratoCargo, type ConceptoRenglonCargo, type EstadoContratoCargo, type ReglaImporteCargo,
  type SerieParaProponer, type TipoContratoCargo,
} from '@megadulces/contracts';
import { VISTA_DE_CARGOS } from '../payment-calendar/suficiencia-de-cuentas.query';

/**
 * `[PGP.210]` C1 — **Escribir y leer el contrato de un cargo del banco** (anexo CR §3.1–§3.2, DCR1/DCR2). Los caminos que
 * insertan o cambian un contrato son SÓLO éstos (regla 14: si una columna cambia, se recorren aquí):
 *
 *  · `proponerDesdeLaHistoria` — el sistema propone (DCR1): cada serie vigente de `[PGP.209]` que ningún renglón cita
 *    se vuelve un contrato `propuesto` (el crédito agrupa sus conceptos por su número). Idempotente: correrla dos veces
 *    no propone dos veces (y una propuesta rechazada no se vuelve a proponer: su renglón sigue citando la serie).
 *  · `crearContrato` — una persona da de alta un contrato que el detector no ve (la línea de crédito de BBVA, uno
 *    nuevo). Nace `propuesto`, como todos: confirmar es otro acto.
 *  · `confirmarContrato` — Tesorería confirma (y corrige lo que haga falta); se niega con lo que falta, en llano.
 *  · `terminarContrato` / `cancelarContrato` — con motivo. Nada se borra.
 *
 * La API y la pantalla son `[PGP.213]`/`[PGP.214]`; aquí no se decide quién puede (el permiso lo pone la API).
 */

export type CodigoErrorContrato = 'no_existe' | 'transicion' | 'incompleto' | 'invalido';
export class ErrorDeContrato extends Error {
  constructor(readonly codigo: CodigoErrorContrato, mensaje: string) { super(mensaje); this.name = 'ErrorDeContrato'; }
}

export interface ResultadoDePropuesta {
  /** Series vigentes que leyó del banco. */
  series: number;
  /** De ésas, las que ya cita algún renglón (propuesto, confirmado, terminado o rechazado). */
  ya_citadas: number;
  contratos: number;
  renglones: number;
}

/** El candado de la propuesta por tenant: dos corridas a la vez no proponen dos veces la misma serie. */
const candado = (trx: Knex | Knex.Transaction, tenantId: string) =>
  trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`pgp210:proponer:${tenantId}`]);

export async function proponerDesdeLaHistoria(
  trx: Knex.Transaction, tenantId: string, actor: string, opciones: { vistaDeCargos?: string } = {},
): Promise<ResultadoDePropuesta> {
  await candado(trx, tenantId);
  const fuente = opciones.vistaDeCargos ?? VISTA_DE_CARGOS;
  const series = (await trx.raw(`
    SELECT v.series_key, v.rule, v.bank_account_id::text AS bank_account_id, v.concept_head, v.latest_concept, v.category_code,
           v.months, v.charges, v.charges_per_month, v.fixed_amount::float AS fixed_amount, v.last_amount::float AS last_amount,
           v.min_amount::float AS min_amount, v.max_amount::float AS max_amount,
           to_char(v.first_charge_date, 'YYYY-MM-DD') AS first_charge_date, to_char(v.last_charge_date, 'YYYY-MM-DD') AS last_charge_date,
           v.min_day, v.max_day, ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(v.movement_dates) d) AS movement_dates
      FROM ${fuente} v
     WHERE v.tenant_id = ? AND v.is_active
     ORDER BY v.bank_account_id, v.series_key`, [tenantId])).rows as SerieParaProponer[];
  const citadas = new Set(((await trx('finance.charge_contract_lines')
    .where({ tenant_id: tenantId }).whereNotNull('series_key').select('series_key')) as { series_key: string }[]).map((r) => r.series_key));
  const nuevas = series.filter((s) => !citadas.has(s.series_key));
  let contratos = 0, renglones = 0;
  for (const p of agruparPropuestas(nuevas)) {
    const [c] = await trx('finance.charge_contracts').insert({
      tenant_id: tenantId, kind: p.tipo, creditor_name: p.acreedor, charge_bank_account_id: p.bank_account_id, cadence: 'mensual',
      day_from: p.dia_desde, day_to: p.dia_hasta, starts_on: p.inicio, status: 'propuesto', origin: 'historia',
      evidence: JSON.stringify(p.evidencia), created_by: actor, updated_by: actor,
    }).returning('id');
    contratos++;
    let orden = 1;
    for (const r of p.renglones) {
      await trx('finance.charge_contract_lines').insert({
        tenant_id: tenantId, contract_id: (c as { id: string }).id, concept: r.concepto, description: r.descripcion, bank_concept_head: r.cabeza_banco,
        amount_rule: r.regla_importe, fixed_amount: r.importe_fijo, charges_per_period: r.cargos_por_periodo, series_key: r.series_key,
        sort_order: orden++, created_by: actor, updated_by: actor,
      });
      renglones++;
    }
  }
  return { series: series.length, ya_citadas: series.length - nuevas.length, contratos, renglones };
}

export interface RenglonNuevo {
  concepto: ConceptoRenglonCargo;
  descripcion: string;
  cabeza_banco?: string | null;
  regla_importe: ReglaImporteCargo;
  importe_fijo?: number | null;
  cargos_por_periodo?: number;
  tasa_referencia?: string | null;
  tasa_puntos?: number | null;
  base_dias?: 360 | 365 | null;
  series_key?: string | null;
  /** La tabla de amortización de un renglón «por tabla». */
  tabla?: { fecha: string; importe: number; saldo?: number | null }[];
}

export interface ContratoNuevo {
  tipo: TipoContratoCargo;
  acreedor: string;
  referencia?: string | null;
  cuenta_id: string;
  cadencia: CadenciaContratoCargo;
  dia_desde: number;
  dia_hasta: number;
  inicio?: string | null;
  fin?: string | null;
  kepler_acreedor?: string | null;
  sucursal?: string | null;
  notas?: string | null;
  renglones: RenglonNuevo[];
}

export async function crearContrato(trx: Knex.Transaction, tenantId: string, actor: string, d: ContratoNuevo): Promise<string> {
  if (!d.renglones?.length) throw new ErrorDeContrato('invalido', 'Un contrato lleva al menos un concepto de cobro.');
  const [c] = await trx('finance.charge_contracts').insert({
    tenant_id: tenantId, kind: d.tipo, creditor_name: d.acreedor, reference: d.referencia ?? null, charge_bank_account_id: d.cuenta_id,
    cadence: d.cadencia, day_from: d.dia_desde, day_to: d.dia_hasta, starts_on: d.inicio ?? null, ends_on: d.fin ?? null,
    status: 'propuesto', origin: 'manual', kepler_creditor_code: d.kepler_acreedor ?? null, sucursal: d.sucursal ?? null,
    notes: d.notas ?? null, created_by: actor, updated_by: actor,
  }).returning('id');
  const contratoId = (c as { id: string }).id;
  let orden = 1;
  for (const r of d.renglones) {
    const [l] = await trx('finance.charge_contract_lines').insert({
      tenant_id: tenantId, contract_id: contratoId, concept: r.concepto, description: r.descripcion, bank_concept_head: r.cabeza_banco ?? null,
      amount_rule: r.regla_importe, fixed_amount: r.importe_fijo ?? null, charges_per_period: r.cargos_por_periodo ?? 1,
      rate_reference: r.tasa_referencia ?? null, rate_spread: r.tasa_puntos ?? null, day_count_basis: r.base_dias ?? null,
      series_key: r.series_key ?? null, sort_order: orden++, created_by: actor, updated_by: actor,
    }).returning('id');
    for (const f of r.tabla ?? []) {
      await trx('finance.charge_contract_schedule').insert({
        tenant_id: tenantId, line_id: (l as { id: string }).id, due_date: f.fecha, amount: f.importe, principal_balance: f.saldo ?? null,
        created_by: actor, updated_by: actor,
      });
    }
  }
  return contratoId;
}

interface FilaContrato {
  id: string; status: EstadoContratoCargo; kind: TipoContratoCargo; creditor_name: string; cadence: CadenciaContratoCargo;
  day_from: number; day_to: number; starts_on: string | null; ends_on: string | null; document_storage_key: string | null;
}

async function contratoParaCambiar(trx: Knex.Transaction, tenantId: string, id: string): Promise<FilaContrato> {
  const c = await trx('finance.charge_contracts').where({ tenant_id: tenantId, id }).forUpdate()
    .first('id', 'status', 'kind', 'creditor_name', 'cadence', 'day_from', 'day_to', 'document_storage_key',
      trx.raw(`to_char(starts_on, 'YYYY-MM-DD') AS starts_on`), trx.raw(`to_char(ends_on, 'YYYY-MM-DD') AS ends_on`)) as FilaContrato | undefined;
  if (!c) throw new ErrorDeContrato('no_existe', 'Ese contrato no existe.');
  return c;
}

const NOMBRE_ESTADO: Record<EstadoContratoCargo, string> = { propuesto: 'propuesto', confirmado: 'confirmado', terminado: 'terminado', cancelado: 'rechazado' };
function exigirTransicion(c: FilaContrato, a: EstadoContratoCargo): void {
  if (!transicionPermitida(c.status, a)) {
    throw new ErrorDeContrato('transicion', `El contrato está ${NOMBRE_ESTADO[c.status]}: no se puede pasar a ${NOMBRE_ESTADO[a]}.`);
  }
}

export interface CambiosAlConfirmar {
  tipo?: TipoContratoCargo;
  acreedor?: string;
  referencia?: string | null;
  cadencia?: CadenciaContratoCargo;
  dia_desde?: number;
  dia_hasta?: number;
  inicio?: string | null;
  fin?: string | null;
  kepler_acreedor?: string | null;
  sucursal?: string | null;
  documento?: { storage_key: string; nombre: string } | null;
  notas?: string | null;
}

/** Tesorería confirma, con las correcciones que traiga. Se niega con lo que falta (`problemasParaConfirmar`). */
export async function confirmarContrato(
  trx: Knex.Transaction, tenantId: string, id: string, actor: string, cambios: CambiosAlConfirmar = {},
): Promise<void> {
  const c = await contratoParaCambiar(trx, tenantId, id);
  exigirTransicion(c, 'confirmado');
  const renglones = (await trx.raw(`
    SELECT l.description, l.amount_rule, l.fixed_amount::float AS fixed_amount,
           (SELECT count(*)::int FROM finance.charge_contract_schedule s WHERE s.line_id = l.id) AS filas
      FROM finance.charge_contract_lines l WHERE l.tenant_id = ? AND l.contract_id = ?`, [tenantId, id])).rows as
    { description: string; amount_rule: ReglaImporteCargo; fixed_amount: number | null; filas: number }[];
  const queda = {
    tipo: cambios.tipo ?? c.kind, acreedor: cambios.acreedor ?? c.creditor_name, cadencia: cambios.cadencia ?? c.cadence,
    dia_desde: cambios.dia_desde ?? c.day_from, dia_hasta: cambios.dia_hasta ?? c.day_to,
    inicio: cambios.inicio !== undefined ? cambios.inicio : c.starts_on, fin: cambios.fin !== undefined ? cambios.fin : c.ends_on,
    // DCR11: el PDF que ya tiene o el que trae al confirmar.
    tiene_documento: cambios.documento !== undefined ? !!cambios.documento?.storage_key : !!c.document_storage_key,
  };
  const problemas = problemasParaConfirmar(queda, renglones.map((r) => ({
    descripcion: r.description, regla_importe: r.amount_rule, importe_fijo: r.fixed_amount, filas_de_tabla: r.filas,
  })));
  if (problemas.length) throw new ErrorDeContrato('incompleto', problemas.join(' '));
  const set: Record<string, unknown> = {
    kind: queda.tipo, creditor_name: queda.acreedor, cadence: queda.cadencia, day_from: queda.dia_desde, day_to: queda.dia_hasta,
    starts_on: queda.inicio, ends_on: queda.fin, status: 'confirmado', confirmed_at: trx.fn.now(), confirmed_by: actor,
    updated_at: trx.fn.now(), updated_by: actor,
  };
  if (cambios.referencia !== undefined) set['reference'] = cambios.referencia;
  if (cambios.kepler_acreedor !== undefined) set['kepler_creditor_code'] = cambios.kepler_acreedor;
  if (cambios.sucursal !== undefined) set['sucursal'] = cambios.sucursal;
  if (cambios.notas !== undefined) set['notes'] = cambios.notas;
  if (cambios.documento !== undefined) {
    set['document_storage_key'] = cambios.documento?.storage_key ?? null;
    set['document_name'] = cambios.documento?.nombre ?? null;
  }
  await trx('finance.charge_contracts').where({ tenant_id: tenantId, id }).update(set);
}

const exigirMotivo = (motivo: string) => {
  if (String(motivo ?? '').trim().length < 3) throw new ErrorDeContrato('invalido', 'Escribe el motivo (3 letras o más).');
};

/** Un contrato confirmado que ya no cobra (se pagó el crédito, venció el arrendamiento): con motivo y fecha de fin. */
export async function terminarContrato(
  trx: Knex.Transaction, tenantId: string, id: string, actor: string, motivo: string, fin?: string | null,
): Promise<void> {
  exigirMotivo(motivo);
  const c = await contratoParaCambiar(trx, tenantId, id);
  exigirTransicion(c, 'terminado');
  await trx('finance.charge_contracts').where({ tenant_id: tenantId, id }).update({
    status: 'terminado', terminated_at: trx.fn.now(), terminated_by: actor, end_reason: motivo.trim(),
    ends_on: fin ?? c.ends_on ?? trx.raw(`(now() AT TIME ZONE 'America/Mexico_City')::date`), updated_at: trx.fn.now(), updated_by: actor,
  });
}

/** Una propuesta que Tesorería rechaza («no es un contrato»): con motivo. No se vuelve a proponer. */
export async function cancelarContrato(trx: Knex.Transaction, tenantId: string, id: string, actor: string, motivo: string): Promise<void> {
  exigirMotivo(motivo);
  const c = await contratoParaCambiar(trx, tenantId, id);
  exigirTransicion(c, 'cancelado');
  await trx('finance.charge_contracts').where({ tenant_id: tenantId, id }).update({
    status: 'cancelado', cancelled_at: trx.fn.now(), cancelled_by: actor, cancel_reason: motivo.trim(), updated_at: trx.fn.now(), updated_by: actor,
  });
}
