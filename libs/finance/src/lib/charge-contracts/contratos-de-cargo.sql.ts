import type { Knex } from 'knex';
import {
  agruparPropuestas, problemasDeEncabezado, problemasDeRenglon, problemasParaConfirmar, sePuedeEditar, sePuedeSubirDocumento,
  transicionPermitida,
  type CadenciaContratoCargo, type CargoSinContrato, type CargosSinContratoResponse, type ConceptoRenglonCargo, type ContratoCargo,
  type EditarContratoCargoBody, type EstadoContratoCargo, type EvidenciaDeSerie, type FilaTablaContratoCargo,
  type MotivoCargoAutomatico, type OrigenContratoCargo, type ReglaImporteCargo, type RenglonContratoCargo, type SerieParaProponer,
  type TipoContratoCargo,
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

/** `sin_medir` = falta la tabla o la vista (migración sin aplicar): no es «cero contratos». */
export type CodigoErrorContrato = 'no_existe' | 'transicion' | 'incompleto' | 'invalido' | 'sin_medir';
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
  // `[PGP.213]` Lo obligatorio, y lo que trae mal, en llano (antes de que lo diga un CHECK de la base).
  const faltan = (['tipo', 'acreedor', 'cuenta_id', 'cadencia', 'dia_desde', 'dia_hasta'] as const)
    .filter((k) => d[k] === undefined || d[k] === null || d[k] === '').map((k) => `Falta ${k.replace('_', ' ')}.`);
  exigirCuerpo([...faltan, ...problemasDeEncabezado(d), ...d.renglones.flatMap((r, i) => problemasDeRenglon(r, i + 1))]);
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
    await escribirTabla(trx, tenantId, (l as { id: string }).id, actor, r.tabla ?? []);
  }
  return contratoId;
}

/** La tabla de amortización de un renglón, fila por fila (la única que escribe `finance.charge_contract_schedule`). */
async function escribirTabla(trx: Knex.Transaction, tenantId: string, lineId: string, actor: string, filas: readonly FilaTablaContratoCargo[]): Promise<void> {
  for (const f of filas) {
    await trx('finance.charge_contract_schedule').insert({
      tenant_id: tenantId, line_id: lineId, due_date: f.fecha, amount: f.importe, principal_balance: f.saldo ?? null,
      created_by: actor, updated_by: actor,
    });
  }
}

/** `[PGP.213]` Lo que trae mal un cuerpo de la pantalla: un 400 que dice qué corregir. */
function exigirCuerpo(problemas: readonly string[]): void {
  if (problemas.length) throw new ErrorDeContrato('invalido', problemas.join(' '));
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
  exigirCuerpo(problemasDeEncabezado(cambios));
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

// ─── [PGP.213] Corregir una propuesta, su PDF, y las lecturas de la API ─────────────────────────

/**
 * `[PGP.213]` **Corregir una PROPUESTA** antes de confirmarla (`sePuedeEditar`): el encabezado y sus renglones. Un renglón
 * con `id` se corrige COMPLETO (lo que manda la pantalla es el renglón entero; su serie del banco y su cabeza no cambian:
 * son la evidencia); sin `id`, se agrega al final. Con `tabla`, la tabla de amortización de ese renglón se reemplaza
 * entera. Ningún renglón se borra.
 */
export async function editarPropuesta(
  trx: Knex.Transaction, tenantId: string, id: string, actor: string, b: EditarContratoCargoBody,
): Promise<void> {
  const renglones = b.renglones ?? [];
  exigirCuerpo([...problemasDeEncabezado(b), ...renglones.flatMap((r, i) => problemasDeRenglon(r, i + 1))]);
  const c = await contratoParaCambiar(trx, tenantId, id);
  if (!sePuedeEditar(c.status)) {
    throw new ErrorDeContrato('transicion', `El contrato está ${NOMBRE_ESTADO[c.status]}: sólo una propuesta se corrige. Si cambió el contrato real, termínalo y da de alta el nuevo.`);
  }
  // Lo que queda (lo que trae + lo que ya tenía) tiene que seguir siendo consistente: días con su cadencia, fin ≥ inicio.
  exigirCuerpo(problemasDeEncabezado({
    cadencia: b.cadencia ?? c.cadence, dia_desde: b.dia_desde ?? c.day_from, dia_hasta: b.dia_hasta ?? c.day_to,
    inicio: b.inicio !== undefined ? b.inicio : c.starts_on, fin: b.fin !== undefined ? b.fin : c.ends_on,
  }));
  const MAPA: [keyof EditarContratoCargoBody, string][] = [
    ['tipo', 'kind'], ['acreedor', 'creditor_name'], ['referencia', 'reference'], ['cadencia', 'cadence'], ['dia_desde', 'day_from'],
    ['dia_hasta', 'day_to'], ['inicio', 'starts_on'], ['fin', 'ends_on'], ['kepler_acreedor', 'kepler_creditor_code'], ['sucursal', 'sucursal'],
    ['notas', 'notes'],
  ];
  const set: Record<string, unknown> = {};
  for (const [k, col] of MAPA) if (b[k] !== undefined) set[col] = typeof b[k] === 'string' ? (b[k] as string).trim() || null : b[k];
  if (set['creditor_name'] === null) delete set['creditor_name'];
  await trx('finance.charge_contracts').where({ tenant_id: tenantId, id })
    .update({ ...set, updated_at: trx.fn.now(), updated_by: actor });

  let siguiente = Number((await trx('finance.charge_contract_lines').where({ tenant_id: tenantId, contract_id: id }).max('sort_order as m').first())?.['m'] ?? 0) + 1;
  for (const [i, r] of renglones.entries()) {
    const fila = {
      concept: r.concepto, description: r.descripcion.trim(), amount_rule: r.regla_importe,
      fixed_amount: r.regla_importe === 'fijo' ? Number(r.importe_fijo) : null,
      rate_reference: r.tasa_referencia?.trim() || null,
      rate_spread: r.tasa_puntos === undefined || r.tasa_puntos === null ? null : Number(r.tasa_puntos),
      day_count_basis: r.base_dias ?? null,
      updated_at: trx.fn.now(), updated_by: actor,
    };
    let lineId = r.id;
    if (lineId) {
      const existe = await trx('finance.charge_contract_lines').where({ tenant_id: tenantId, contract_id: id, id: lineId }).first('id', 'charges_per_period');
      if (!existe) throw new ErrorDeContrato('invalido', `Concepto ${i + 1}: no es de este contrato.`);
      await trx('finance.charge_contract_lines').where({ tenant_id: tenantId, id: lineId })
        .update({ ...fila, charges_per_period: r.cargos_por_periodo ?? existe.charges_per_period });
    } else {
      const [l] = await trx('finance.charge_contract_lines').insert({
        ...fila, tenant_id: tenantId, contract_id: id, bank_concept_head: r.cabeza_banco ?? null, charges_per_period: r.cargos_por_periodo ?? 1,
        sort_order: siguiente++, created_by: actor,
      }).returning('id');
      lineId = (l as { id: string }).id;
    }
    if (r.tabla !== undefined) {
      await trx('finance.charge_contract_schedule').where({ tenant_id: tenantId, line_id: lineId }).del();
      await escribirTabla(trx, tenantId, lineId, actor, r.tabla);
    }
  }
}

/** `[PGP.213]` El PDF del contrato (DCR11), ya subido al almacenamiento: a una propuesta o a un confirmado. */
export async function guardarDocumento(
  trx: Knex.Transaction, tenantId: string, id: string, actor: string, doc: { storage_key: string; nombre: string },
): Promise<void> {
  const c = await contratoParaCambiar(trx, tenantId, id);
  if (!sePuedeSubirDocumento(c.status)) throw new ErrorDeContrato('transicion', `El contrato está ${NOMBRE_ESTADO[c.status]}: ya no lleva documento.`);
  const nombre = String(doc.nombre ?? '').trim().slice(0, 200) || 'contrato.pdf';
  await trx('finance.charge_contracts').where({ tenant_id: tenantId, id }).update({
    document_storage_key: doc.storage_key, document_name: nombre, updated_at: trx.fn.now(), updated_by: actor,
  });
}

/** `[PGP.213]` La llave del PDF guardado (para firmar su URL), o `null` si no tiene. */
export async function llaveDelDocumento(trx: Knex.Transaction, tenantId: string, id: string): Promise<{ llave: string | null; nombre: string | null }> {
  const c = await trx('finance.charge_contracts').where({ tenant_id: tenantId, id }).first('document_storage_key', 'document_name') as
    { document_storage_key: string | null; document_name: string | null } | undefined;
  if (!c) throw new ErrorDeContrato('no_existe', 'Ese contrato no existe.');
  return { llave: c.document_storage_key, nombre: c.document_name };
}

const existeObjeto = async (trx: Knex.Transaction, objeto: string): Promise<boolean> =>
  (await trx.raw(`SELECT to_regclass(?) IS NOT NULL AS t`, [objeto])).rows[0].t === true;

const iso = (v: Date | string | null | undefined): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));

interface FilaLeida {
  id: string; kind: TipoContratoCargo; status: EstadoContratoCargo; origin: OrigenContratoCargo; creditor_name: string; reference: string | null;
  cuenta_id: string; bank: string; account_label: string; cadence: CadenciaContratoCargo; day_from: number; day_to: number;
  inicio: string | null; fin: string | null; kepler_creditor_code: string | null; sucursal: string | null; notes: string | null;
  con_documento: boolean; document_name: string | null; evidence: EvidenciaDeSerie[] | null;
  created_by: string; created_at: Date; confirmed_by: string | null; confirmed_at: Date | null; terminated_by: string | null;
  terminated_at: Date | null; end_reason: string | null; cancelled_by: string | null; cancelled_at: Date | null; cancel_reason: string | null;
}
interface RenglonLeido {
  id: string; contract_id: string; concept: ConceptoRenglonCargo; description: string; bank_concept_head: string | null;
  amount_rule: ReglaImporteCargo; fixed_amount: number | null; charges_per_period: number; rate_reference: string | null;
  rate_spread: number | null; day_count_basis: number | null; series_key: string | null; sort_order: number; tabla: FilaTablaContratoCargo[];
}

/**
 * `[PGP.213]` Todos los contratos del tenant, con su cuenta, sus renglones y su tabla (son decenas: sin paginar). Primero
 * las propuestas (lo que espera a Tesorería), después los confirmados, al final terminados y rechazados.
 */
export async function leerContratos(trx: Knex.Transaction, tenantId: string): Promise<ContratoCargo[]> {
  if (!(await existeObjeto(trx, 'finance.charge_contracts'))) {
    throw new ErrorDeContrato('sin_medir', 'Los contratos todavía no existen en esta base (falta aplicar la migración 20261126001551).');
  }
  const filas = (await trx.raw(`
    SELECT c.id::text, c.kind, c.status, c.origin, c.creditor_name, c.reference, c.charge_bank_account_id::text AS cuenta_id,
           ba.bank, ba.account_label, c.cadence, c.day_from, c.day_to,
           to_char(c.starts_on, 'YYYY-MM-DD') AS inicio, to_char(c.ends_on, 'YYYY-MM-DD') AS fin,
           c.kepler_creditor_code, c.sucursal, c.notes, (c.document_storage_key IS NOT NULL) AS con_documento, c.document_name, c.evidence,
           c.created_by, c.created_at, c.confirmed_by, c.confirmed_at, c.terminated_by, c.terminated_at, c.end_reason,
           c.cancelled_by, c.cancelled_at, c.cancel_reason
      FROM finance.charge_contracts c
      JOIN finance.bank_accounts ba ON ba.id = c.charge_bank_account_id
     WHERE c.tenant_id = ?
     ORDER BY CASE c.status WHEN 'propuesto' THEN 0 WHEN 'confirmado' THEN 1 ELSE 2 END, c.creditor_name, c.id`, [tenantId])).rows as FilaLeida[];
  const renglones = (await trx.raw(`
    SELECT l.id::text, l.contract_id::text, l.concept, l.description, l.bank_concept_head, l.amount_rule, l.fixed_amount::float8 AS fixed_amount,
           l.charges_per_period, l.rate_reference, l.rate_spread::float8 AS rate_spread, l.day_count_basis, l.series_key, l.sort_order,
           coalesce((SELECT json_agg(json_build_object('fecha', to_char(s.due_date, 'YYYY-MM-DD'), 'importe', s.amount::float8,
                                                      'saldo', s.principal_balance::float8) ORDER BY s.due_date)
                       FROM finance.charge_contract_schedule s WHERE s.tenant_id = l.tenant_id AND s.line_id = l.id), '[]'::json) AS tabla
      FROM finance.charge_contract_lines l
     WHERE l.tenant_id = ?
     ORDER BY l.contract_id, l.sort_order, l.id`, [tenantId])).rows as RenglonLeido[];
  const porContrato = new Map<string, RenglonContratoCargo[]>();
  for (const r of renglones) {
    const lista = porContrato.get(r.contract_id) ?? [];
    lista.push({
      id: r.id, concepto: r.concept, descripcion: r.description, cabeza_banco: r.bank_concept_head, regla_importe: r.amount_rule,
      importe_fijo: r.fixed_amount, cargos_por_periodo: Number(r.charges_per_period), tasa_referencia: r.rate_reference,
      tasa_puntos: r.rate_spread, base_dias: r.day_count_basis === null ? null : Number(r.day_count_basis), series_key: r.series_key,
      orden: Number(r.sort_order), tabla: r.tabla ?? [],
    });
    porContrato.set(r.contract_id, lista);
  }
  return filas.map((c) => {
    const rs = porContrato.get(c.id) ?? [];
    return {
      id: c.id, tipo: c.kind, estado: c.status, origen: c.origin, acreedor: c.creditor_name, referencia: c.reference,
      cuenta: { id: c.cuenta_id, banco: c.bank, etiqueta: c.account_label }, cadencia: c.cadence, dia_desde: Number(c.day_from),
      dia_hasta: Number(c.day_to), inicio: c.inicio, fin: c.fin, kepler_acreedor: c.kepler_creditor_code, sucursal: c.sucursal, notas: c.notes,
      documento: c.con_documento ? { nombre: c.document_name } : null,
      evidencia: Array.isArray(c.evidence) ? c.evidence : [],
      renglones: rs,
      faltan_para_confirmar: c.status === 'propuesto' ? problemasParaConfirmar({
        tipo: c.kind, acreedor: c.creditor_name, cadencia: c.cadence, dia_desde: Number(c.day_from), dia_hasta: Number(c.day_to),
        inicio: c.inicio, fin: c.fin, tiene_documento: c.con_documento,
      }, rs.map((r) => ({ descripcion: r.descripcion, regla_importe: r.regla_importe, importe_fijo: r.importe_fijo, filas_de_tabla: r.tabla.length }))) : [],
      alta: { por: c.created_by, el: iso(c.created_at) },
      confirmado: c.confirmed_at ? { por: c.confirmed_by ?? '', el: iso(c.confirmed_at) } : null,
      terminado: c.terminated_at ? { por: c.terminated_by ?? '', el: iso(c.terminated_at), motivo: c.end_reason } : null,
      rechazado: c.cancelled_at ? { por: c.cancelled_by ?? '', el: iso(c.cancelled_at), motivo: c.cancel_reason } : null,
    };
  });
}

/**
 * `[PGP.213]` Los cargos automáticos del banco que NO sustenta un contrato confirmado (`[PGP.212]`), del más nuevo al más
 * viejo. `total` e `importe_total` cuentan TODO el rango aunque la lista se tope (Cruce 1: la cifra se puede recorrer).
 */
export async function leerCargosSinContrato(
  trx: Knex.Transaction, tenantId: string, desde: string, hasta: string, limit: number,
): Promise<CargosSinContratoResponse> {
  if (!(await existeObjeto(trx, 'finance.v_automatic_bank_charges'))) {
    throw new ErrorDeContrato('sin_medir', 'La vista de cargos automáticos todavía no existe en esta base (falta aplicar la migración 20261126004656).');
  }
  const filas = (await trx.raw(`
    WITH v AS MATERIALIZED (
      SELECT a.bank_movement_id, a.bank_account_id, a.movement_date, a.amount, a.concept, a.concept_head, a.series_key, a.detected_by,
             a.contract_id, a.reason
        FROM finance.v_automatic_bank_charges a
       WHERE a.tenant_id = ? AND NOT a.supported AND a.movement_date BETWEEN ?::date AND ?::date)
    SELECT v.bank_movement_id::text AS movimiento_id, v.bank_account_id::text AS cuenta_id, ba.bank, ba.account_label,
           to_char(v.movement_date, 'YYYY-MM-DD') AS fecha, v.amount::float8 AS importe, v.concept, v.concept_head, v.series_key,
           v.detected_by, v.contract_id::text AS contrato_id, v.reason,
           count(*) OVER ()::int AS total, coalesce(sum(v.amount) OVER (), 0)::float8 AS importe_total
      FROM v JOIN finance.bank_accounts ba ON ba.id = v.bank_account_id
     ORDER BY v.movement_date DESC, v.amount DESC, v.bank_movement_id
     LIMIT ?`, [tenantId, desde, hasta, limit + 1])).rows as {
      movimiento_id: string; cuenta_id: string; bank: string; account_label: string; fecha: string; importe: number; concept: string | null;
      concept_head: string | null; series_key: string | null; detected_by: string | null; contrato_id: string | null; reason: MotivoCargoAutomatico;
      total: number; importe_total: number;
    }[];
  const cargos: CargoSinContrato[] = filas.slice(0, limit).map((f) => ({
    movimiento_id: f.movimiento_id, cuenta: { id: f.cuenta_id, banco: f.bank, etiqueta: f.account_label }, fecha: f.fecha, importe: Number(f.importe),
    concepto: f.concept, cabeza: f.concept_head, serie: f.series_key, detectado_por: f.detected_by, contrato_id: f.contrato_id, motivo: f.reason,
  }));
  // Sin filas en la página, el total se vuelve a contar: un rango vacío da 0, no «sin dato».
  const total = filas.length ? Number(filas[0].total) : 0;
  const importe = filas.length ? Math.round(Number(filas[0].importe_total) * 100) / 100 : 0;
  return { desde, hasta, cargos, total, importe_total: importe, limit, has_more: total > cargos.length };
}
