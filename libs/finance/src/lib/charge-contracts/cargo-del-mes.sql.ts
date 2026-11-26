import type { Knex } from 'knex';
import {
  ESTADOS_DIA_AUTORIZADO, autorizadoPorContrato, fechaEsperadaDelPeriodo, interesDelPeriodo, periodosDelHorizonte, subtipoDelCargo,
  type CadenciaContratoCargo, type CobroDeInteres, type ConceptoRenglonCargo, type InteresDelPeriodo, type ReglaImporteCargo,
  type TipoContratoCargo,
} from '@megadulces/contracts';
import { recalcularObligacion } from '../payment-calendar/recalcular-obligacion';
import { SQL_SALIDAS_LIGADAS } from '../payment-calendar/pago-por-el-banco.sql';

/**
 * `[PGP.211]` C1 — **El cargo de cada mes de un contrato confirmado, programado en el Calendario** (anexo CR §3.3).
 * Los únicos caminos que escriben el cargo de un contrato (regla 14):
 *
 *  · `generarCargosDelMes` — por cada renglón de un contrato CONFIRMADO y cada periodo del horizonte (este mes y el
 *    siguiente): el cargo en `finance.financial_commitments` (con su contrato, renglón y periodo: único) y su pago en el
 *    día esperado, como `cargo_automatico` desde la cuenta del contrato, YA AUTORIZADO por el contrato (DCR5: «la firma
 *    es la del contrato»). Idempotente. Lo que no genera, lo dice con su motivo (`omitidos`).
 *  · `cerrarCargosCobrados` — cuando el banco cobra, el pago queda pagado con su salida. ⭐ No por importe y fecha
 *    (`[PGP.121]`: ±$1, ±3 días, uno a uno), que falla aquí: en noviembre la arrendadora cobró hasta 9 días tarde y dos
 *    contratos del mismo importe el mismo día quedan «disputados». Se cierra por la liga que ya da `[PGP.212]`: los
 *    movimientos «con contrato» de ESE renglón, entre 10 días antes y 25 después del día esperado, tantos como cargos
 *    por periodo. Un importe estimado toma el que cobró el banco.
 *
 * `[PGP.219]` **El interés de un crédito, calculado** (DCR8/DCR10): en un renglón «estimado» de interés o de su IVA, el
 * importe ya no es lo último que cobró el banco sino saldo × tasa implícita del último cargo × días
 * (`interesDelPeriodo`, `@megadulces/contracts`), con la historia de las series del crédito. Si no se puede calcular
 * (capital por tabla, tasa que cambió, poca historia), se queda lo último cobrado y la nota dice por qué.
 *  · `recalcularInteresesDelCredito` — **un día antes** del cargo (y mientras no se cobre) vuelve a calcular el
 *    pendiente: si llegó un cobro nuevo o cambió la tasa, el importe programado se corrige y queda en la bitácora.
 *
 * Quién los llama (el trabajo de cada día) es C2 (`[PGP.213]`).
 */

const VISTA_CARGOS_AUTOMATICOS = 'finance.v_automatic_bank_charges';
const VISTA_SERIES = 'finance.v_recurring_bank_charges';
/** Cuántos meses se programan por adelantado: el de hoy y el siguiente (el de diciembre aparece antes del día 12). */
export const MESES_DEL_HORIZONTE = 2;
/** La ventana del cierre alrededor del día esperado: el banco cobra antes (rara vez) o hasta 9 días tarde (medido). */
export const DIAS_ANTES_DEL_CIERRE = 10;
export const DIAS_DESPUES_DEL_CIERRE = 25;

export const EVENTO_PROGRAMADO_POR_CONTRATO = 'programado_por_contrato';
export const EVENTO_PAGADO_POR_CONTRATO = 'pagado_por_contrato';
export const EVENTO_RECALCULADO_POR_CONTRATO = 'recalculado_por_contrato';

export const NOTA_ULTIMO_COBRADO = 'Importe estimado: lo último que cobró el banco (DCR8/DCR10).';
export const NOTA_INTERES_CALCULADO = 'Interés calculado: saldo × tasa implícita del último cargo × días (DCR8/DCR10); estimado.';

export interface CargoGenerado {
  contrato_id: string; renglon_id: string; periodo: string; fecha: string; importe: number; base: ReglaImporteCargo; allocation_id: string;
  /** `[PGP.219]` El importe salió del cálculo del interés (no de lo último cobrado). */
  interes_calculado?: boolean;
}
export interface CargoOmitido { contrato_id: string; renglon_id: string; periodo: string; motivo: string }
export interface ResultadoCargosDelMes { generados: CargoGenerado[]; ya_estaban: number; omitidos: CargoOmitido[] }

interface RenglonVigente {
  contrato_id: string; kind: TipoContratoCargo; creditor_name: string; cuenta: string; cadence: CadenciaContratoCargo; day_from: number;
  inicio: string | null; fin: string | null; kepler_creditor_code: string | null; confirmed_at: Date | string;
  renglon_id: string; concept: ConceptoRenglonCargo; description: string; amount_rule: ReglaImporteCargo; fixed_amount: number | null;
  charges_per_period: number; series_key: string | null; bank_concept_head: string | null;
}

const existe = async (trx: Knex | Knex.Transaction, rel: string) => Boolean((await trx.raw(`SELECT to_regclass(?) IS NOT NULL AS t`, [rel])).rows[0]?.t);
const finDelPeriodo = (p: string) => fechaEsperadaDelPeriodo(p, 31);
const masDias = (f: string, n: number) => { const d = new Date(`${f}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const redondo = (n: number) => Math.round(n * 100) / 100;

/** Los renglones de los contratos confirmados (o sólo de `contratos`). */
async function leerRenglones(trx: Knex.Transaction, tenantId: string, contratos?: string[]): Promise<RenglonVigente[]> {
  return (await trx.raw(`
    SELECT c.id::text AS contrato_id, c.kind, c.creditor_name, c.charge_bank_account_id::text AS cuenta, c.cadence, c.day_from,
           to_char(c.starts_on, 'YYYY-MM-DD') AS inicio, to_char(c.ends_on, 'YYYY-MM-DD') AS fin, c.kepler_creditor_code, c.confirmed_at,
           l.id::text AS renglon_id, l.concept, l.description, l.amount_rule, l.fixed_amount::float AS fixed_amount, l.charges_per_period, l.series_key,
           l.bank_concept_head
      FROM finance.charge_contracts c
      JOIN finance.charge_contract_lines l ON l.tenant_id = c.tenant_id AND l.contract_id = c.id
     WHERE c.tenant_id = ? AND c.status = 'confirmado' ${contratos ? 'AND c.id = ANY(?::uuid[])' : ''}
     ORDER BY c.id, l.sort_order, l.id`, contratos ? [tenantId, contratos] : [tenantId])).rows as RenglonVigente[];
}

// ─── [PGP.219] El interés del crédito, calculado ────────────────────────────────────────────────

type ParteDelInteres = 'real' | 'no_real' | 'iva';

/** Qué parte del interés de un crédito cobra el renglón: el real («pago de intereses»), el no real o su IVA. */
export function parteDelInteres(r: Pick<RenglonVigente, 'kind' | 'concept' | 'bank_concept_head' | 'description'>): ParteDelInteres | null {
  if (r.kind !== 'credito') return null;
  if (r.concept === 'iva') return 'iva';
  if (r.concept !== 'interes') return null;
  return /NO\s+REALES/i.test(r.bank_concept_head ?? r.description) ? 'no_real' : 'real';
}

interface CalculoDelCredito { calculos: Map<string, InteresDelPeriodo>; conNoReal: boolean }

/**
 * Por cada crédito con renglones de interés: su historia (los cobros de las series de esos renglones, de la vista de
 * `[PGP.212]`, con o sin contrato) y el interés de cada periodo pedido. La historia sale de la SERIE de cada renglón
 * (el número del crédito va en ella): dos créditos en la misma cuenta, con los mismos conceptos, no se mezclan.
 */
async function calcularIntereses(trx: Knex.Transaction, tenantId: string, renglones: readonly RenglonVigente[], periodos: readonly string[]): Promise<Map<string, CalculoDelCredito>> {
  const out = new Map<string, CalculoDelCredito>();
  const porContrato = new Map<string, RenglonVigente[]>();
  for (const r of renglones) if (r.kind === 'credito') porContrato.set(r.contrato_id, [...(porContrato.get(r.contrato_id) ?? []), r]);
  const conInteres = [...porContrato.entries()].filter(([, ls]) => ls.some((l) => parteDelInteres(l) && l.amount_rule === 'estimado'));
  if (!conInteres.length) return out;
  const sinCalculo = (motivo: string) => new Map(periodos.map((p) => [p, { ok: false as const, motivo }]));
  const hayVista = await existe(trx, VISTA_CARGOS_AUTOMATICOS);
  const series = conInteres.flatMap(([, ls]) => ls.filter((l) => parteDelInteres(l) && l.series_key).map((l) => l.series_key as string));
  const filas = hayVista && series.length ? (await trx.raw(`
    SELECT series_key, to_char(movement_date, 'YYYY-MM') AS periodo, amount::float AS importe
      FROM ${VISTA_CARGOS_AUTOMATICOS} WHERE tenant_id = ? AND series_key = ANY(?::text[])`, [tenantId, series])).rows as { series_key: string; periodo: string; importe: number }[] : [];

  for (const [contrato, ls] of conInteres) {
    const conNoReal = ls.some((l) => parteDelInteres(l) === 'no_real');
    const capitalLinea = ls.find((l) => l.concept === 'capital' && l.amount_rule === 'fijo' && Number(l.fixed_amount) > 0);
    if (!hayVista) { out.set(contrato, { calculos: sinCalculo('Sin la vista de cargos automáticos (PGP.212) no hay historia de la cual calcular.'), conNoReal }); continue; }
    if (!capitalLinea) { out.set(contrato, { calculos: sinCalculo('El capital del crédito no es fijo (va por tabla o no está): sin él no se deriva el saldo.'), conNoReal }); continue; }
    const capital = Number(capitalLinea.fixed_amount) * Math.max(1, capitalLinea.charges_per_period);
    const parteDeSerie = new Map(ls.filter((l) => parteDelInteres(l) && l.series_key).map((l) => [l.series_key as string, parteDelInteres(l) as ParteDelInteres]));
    if (!parteDeSerie.size) { out.set(contrato, { calculos: sinCalculo('Sus renglones de interés no citan la serie del banco: no hay historia del crédito.'), conNoReal }); continue; }
    const cobros = new Map<string, CobroDeInteres>();
    for (const f of filas) {
      const parte = parteDeSerie.get(f.series_key);
      if (!parte) continue;
      const c = cobros.get(f.periodo) ?? { periodo: f.periodo, real: 0, no_real: 0, iva: null };
      if (parte === 'iva') c.iva = redondo((c.iva ?? 0) + f.importe); else c[parte] = redondo(c[parte] + f.importe);
      cobros.set(f.periodo, c);
    }
    const dia = ls[0].day_from;
    out.set(contrato, { calculos: new Map(periodos.map((p) => [p, interesDelPeriodo({ dia, capital, cobros: [...cobros.values()] }, p)])), conNoReal });
  }
  return out;
}

/** El importe de un renglón de interés según el cálculo, o `null` si el cálculo no lo da (y por qué). */
function importeCalculado(r: RenglonVigente, calc: CalculoDelCredito | undefined, periodo: string): { importe: number; calculo: InteresDelPeriodo & { ok: true } } | { motivo: string } | null {
  const parte = parteDelInteres(r);
  if (!parte || r.amount_rule !== 'estimado' || !calc) return null;
  const c = calc.calculos.get(periodo);
  if (!c) return null;
  if (!c.ok) return { motivo: c.motivo };
  if (parte === 'iva') return c.iva === null ? { motivo: 'La historia del crédito no trae su IVA.' } : { importe: c.iva, calculo: c };
  return { importe: parte === 'no_real' ? c.no_real : (calc.conNoReal ? c.real : c.interes), calculo: c };
}

const detalleDelCalculo = (c: InteresDelPeriodo & { ok: true }) => ({
  saldo: c.saldo, tasa_anual: c.tasa_anual, base_dias: c.base_dias, dias: c.dias, interes: c.interes, real: c.real, no_real: c.no_real, iva: c.iva,
  tasa_del_cobro: c.tasa_del_cobro, saldo_fijado_en: c.saldo_fijado_en,
});

export async function generarCargosDelMes(
  trx: Knex.Transaction, tenantId: string, actor: string, hoy: string, opciones: { meses?: number } = {},
): Promise<ResultadoCargosDelMes> {
  await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`pgp211:generar:${tenantId}`]);
  const out: ResultadoCargosDelMes = { generados: [], ya_estaban: 0, omitidos: [] };
  const periodos = periodosDelHorizonte(hoy, opciones.meses ?? MESES_DEL_HORIZONTE);
  const renglones = await leerRenglones(trx, tenantId);
  if (!renglones.length) return out;
  const intereses = await calcularIntereses(trx, tenantId, renglones, periodos);
  const ids = renglones.map((r) => r.renglon_id);

  const yaEstan = new Set(((await trx.raw(`
    SELECT contract_line_id::text || '|' || period AS k FROM finance.financial_commitments
     WHERE tenant_id = ? AND contract_line_id = ANY(?::uuid[]) AND period = ANY(?::text[])`, [tenantId, ids, periodos])).rows as { k: string }[]).map((r) => r.k));
  const hayCargos = await existe(trx, VISTA_CARGOS_AUTOMATICOS);
  const cobrados = new Set<string>();
  const ultimoCobrado = new Map<string, number>();
  if (hayCargos) {
    const filas = (await trx.raw(`
      SELECT contract_line_id::text AS renglon, to_char(movement_date, 'YYYY-MM') AS periodo, amount::float AS importe, movement_date
        FROM ${VISTA_CARGOS_AUTOMATICOS}
       WHERE tenant_id = ? AND contract_line_id = ANY(?::uuid[]) AND reason = 'con_contrato'
       ORDER BY movement_date, bank_movement_id`, [tenantId, ids])).rows as { renglon: string; periodo: string; importe: number }[];
    for (const f of filas) { cobrados.add(`${f.renglon}|${f.periodo}`); ultimoCobrado.set(f.renglon, f.importe); }
  }
  const ultimoDeLaSerie = new Map<string, number>();
  const series = renglones.map((r) => r.series_key).filter((s): s is string => !!s);
  if (series.length && await existe(trx, VISTA_SERIES)) {
    for (const s of (await trx.raw(`SELECT series_key, last_amount::float AS ultimo FROM ${VISTA_SERIES} WHERE tenant_id = ? AND series_key = ANY(?::text[])`,
      [tenantId, series])).rows as { series_key: string; ultimo: number }[]) ultimoDeLaSerie.set(s.series_key, s.ultimo);
  }

  for (const r of renglones) {
    for (const p of periodos) {
      const omitir = (motivo: string) => out.omitidos.push({ contrato_id: r.contrato_id, renglon_id: r.renglon_id, periodo: p, motivo });
      if (yaEstan.has(`${r.renglon_id}|${p}`)) { out.ya_estaban++; continue; }
      if (r.cadence === 'semanal') { omitir('Es semanal: la provisión de nómina es [PGP.215].'); continue; }
      if (r.kepler_creditor_code) { omitir('Tiene acreedor en Kepler: su documento ya está en el Calendario y no se duplica.'); continue; }
      if (r.inicio && finDelPeriodo(p) < r.inicio) { omitir('El contrato todavía no empieza.'); continue; }
      if (r.fin && `${p}-01` > r.fin) { omitir('El contrato ya terminó.'); continue; }
      if (cobrados.has(`${r.renglon_id}|${p}`)) { omitir('El banco ya lo cobró este mes.'); continue; }

      let importe: number | null = null;
      let fecha = fechaEsperadaDelPeriodo(p, r.day_from);
      let nota: string | null = null;
      let calculo: ReturnType<typeof detalleDelCalculo> | null = null;
      const calc = importeCalculado(r, intereses.get(r.contrato_id), p);
      if (calc && 'importe' in calc) {
        importe = calc.importe;
        nota = NOTA_INTERES_CALCULADO;
        calculo = detalleDelCalculo(calc.calculo);
      } else if (r.amount_rule === 'fijo') importe = Number(r.fixed_amount) * Math.max(1, r.charges_per_period);
      else if (r.amount_rule === 'tabla') {
        const filas = (await trx.raw(`
          SELECT to_char(due_date, 'YYYY-MM-DD') AS fecha, amount::float AS importe FROM finance.charge_contract_schedule
           WHERE tenant_id = ? AND line_id = ? AND to_char(due_date, 'YYYY-MM') = ? ORDER BY due_date`, [tenantId, r.renglon_id, p])).rows as { fecha: string; importe: number }[];
        if (!filas.length) { omitir('Su tabla de amortización no tiene pago este mes.'); continue; }
        importe = filas.reduce((t, f) => t + f.importe, 0);
        fecha = filas[0].fecha;
      } else {
        const ultimo = ultimoCobrado.get(r.renglon_id) ?? (r.series_key ? ultimoDeLaSerie.get(r.series_key) : undefined);
        if (ultimo === undefined) { omitir('Importe estimado sin un cobro anterior del banco del cual tomarlo.'); continue; }
        importe = ultimo * Math.max(1, r.charges_per_period);
        nota = NOTA_ULTIMO_COBRADO + (calc && 'motivo' in calc ? ` Sin cálculo del interés: ${calc.motivo}` : '');
      }
      importe = redondo(importe);
      if (!(importe > 0)) { omitir('El importe no es mayor que cero.'); continue; }
      if (r.inicio && fecha < r.inicio) { omitir('El día del cargo cae antes de que empiece el contrato.'); continue; }
      if (r.fin && fecha > r.fin) { omitir('El día del cargo cae después de que termine el contrato.'); continue; }

      await trx.raw(`INSERT INTO finance.payment_calendar_lots (tenant_id, lot_date) VALUES (?, ?) ON CONFLICT (tenant_id, lot_date) DO NOTHING`, [tenantId, fecha]);
      const lote = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: fecha }).first('id', 'status') as { id: string; status: string };
      if (ESTADOS_DIA_AUTORIZADO.includes(lote.status)) { omitir(`El ${fecha} ya se autorizó completo: no admite pagos nuevos.`); continue; }

      const firma = autorizadoPorContrato(r.contrato_id);
      const [fc] = await trx('finance.financial_commitments').insert({
        tenant_id: tenantId, concept: `${r.description} · ${p}`, subtype: subtipoDelCargo(r.kind, r.concept), beneficiary: r.creditor_name,
        bank_account_id: r.cuenta, original_amount: importe, original_due_date: fecha, status: 'pending', is_critical: false,
        authorized_by: firma, authorized_at: r.confirmed_at,
        notes: nota,
        contract_id: r.contrato_id, contract_line_id: r.renglon_id, period: p, amount_basis: r.amount_rule,
        created_by: actor, updated_by: actor,
      }).returning('id');
      const [a] = await trx('finance.payment_allocations').insert({
        tenant_id: tenantId, lot_id: lote.id, classification: 'compromiso_financiero', amount_assigned: importe, status: 'pending',
        payment_method: 'cargo_automatico', bank_account_id: r.cuenta, authorized_by: firma, authorized_at: trx.fn.now(),
        notes: 'Cargo automático de su contrato: lo cobra el banco; la firma es la del contrato (DCR5).', created_by: actor, updated_by: actor,
      }).returning('id');
      const commitmentId = (fc as { id: string }).id, allocationId = (a as { id: string }).id;
      await trx('finance.payment_allocation_items').insert({
        tenant_id: tenantId, allocation_id: allocationId, obligation_source: 'financial_commitment', obligation_id: commitmentId, applied_amount: importe,
      });
      await trx('finance.payment_allocation_history').insert({
        tenant_id: tenantId, allocation_id: allocationId, event: EVENTO_PROGRAMADO_POR_CONTRATO, status_from: null, status_to: 'pending', created_by: actor,
        detail: JSON.stringify({ regla: 'PGP.211', contrato: r.contrato_id, renglon: r.renglon_id, periodo: p, fecha, importe, base: r.amount_rule, ...(calculo ? { calculo } : {}) }),
      });
      await recalcularObligacion(trx, 'financial_commitment', commitmentId);
      out.generados.push({ contrato_id: r.contrato_id, renglon_id: r.renglon_id, periodo: p, fecha, importe, base: r.amount_rule, allocation_id: allocationId, ...(calculo ? { interes_calculado: true } : {}) });
    }
  }
  return out;
}

export interface CargoCerrado { allocation_id: string; renglon_id: string; periodo: string; importe: number; movimientos: string[]; base: ReglaImporteCargo }
export interface CargoEsperando { allocation_id: string; renglon_id: string; periodo: string; motivo: string }
export interface ResultadoCierre { revisados: number; cerrados: CargoCerrado[]; esperando: CargoEsperando[] }

/**
 * El nuevo importe de un cargo estimado todavía pendiente: compromiso, pago y renglón del pago, y la reserva. El orden
 * respeta el CHECK reservado + pagado ≤ original en cada paso. Lo usan el cierre (lo que cobró el banco) y el recálculo
 * del interés un día antes.
 */
async function ajustarImporteEstimado(
  trx: Knex.Transaction, actor: string, p: { commitment_id: string; item_id: string; allocation_id: string; original: number }, nuevo: number,
): Promise<void> {
  if (nuevo > p.original) await trx('finance.financial_commitments').where({ id: p.commitment_id }).update({ original_amount: nuevo, updated_by: actor, updated_at: trx.fn.now() });
  await trx('finance.payment_allocation_items').where({ id: p.item_id }).update({ applied_amount: nuevo });
  await trx('finance.payment_allocations').where({ id: p.allocation_id }).update({ amount_assigned: nuevo, updated_by: actor, updated_at: trx.fn.now() });
  await recalcularObligacion(trx, 'financial_commitment', p.commitment_id);
  if (nuevo < p.original) await trx('finance.financial_commitments').where({ id: p.commitment_id }).update({ original_amount: nuevo, updated_by: actor, updated_at: trx.fn.now() });
}

export interface InteresRecalculado { allocation_id: string; renglon_id: string; periodo: string; antes: number; despues: number }
export interface ResultadoRecalculo { revisados: number; recalculados: InteresRecalculado[]; sin_calculo: { allocation_id: string; periodo: string; motivo: string }[] }

/**
 * `[PGP.219]` **Un día antes del cargo, el interés vuelve a calcularse** (DCR8): los pendientes estimados de interés o de
 * su IVA de un crédito cuyo día es mañana (o ya pasó y el banco no ha cobrado). Si con la historia de hoy el cálculo
 * da otro importe (llegó un cobro nuevo, cambió la tasa o la inflación), se corrige lo programado y queda en la
 * bitácora con el antes y el después. Sin cálculo, no se toca y se dice por qué. Recalcular dos veces no cambia nada.
 */
export async function recalcularInteresesDelCredito(trx: Knex.Transaction, tenantId: string, actor: string, hoy: string): Promise<ResultadoRecalculo> {
  const out: ResultadoRecalculo = { revisados: 0, recalculados: [], sin_calculo: [] };
  const pendientes = (await trx.raw(`
    SELECT a.id::text AS allocation_id, a.amount_assigned::float AS asignado, i.id::text AS item_id, fc.id::text AS commitment_id,
           fc.contract_id::text AS contrato, fc.contract_line_id::text AS renglon, fc.period AS periodo, fc.original_amount::float AS original
      FROM finance.payment_allocations a
      JOIN finance.payment_allocation_items i ON i.allocation_id = a.id AND i.obligation_source = 'financial_commitment'
      JOIN finance.financial_commitments fc ON fc.id = i.obligation_id AND fc.contract_line_id IS NOT NULL
      JOIN finance.charge_contracts c ON c.id = fc.contract_id
      JOIN finance.charge_contract_lines l ON l.id = fc.contract_line_id
     WHERE a.tenant_id = ? AND a.status = 'pending' AND a.paid_bank_movement_id IS NULL AND fc.amount_basis = 'estimado'
       AND c.kind = 'credito' AND l.concept IN ('interes', 'iva') AND fc.original_due_date <= ?::date
     ORDER BY fc.original_due_date, a.id`, [tenantId, masDias(hoy, 1)])).rows as
    { allocation_id: string; asignado: number; item_id: string; commitment_id: string; contrato: string; renglon: string; periodo: string; original: number }[];
  out.revisados = pendientes.length;
  if (!pendientes.length) return out;
  const renglones = await leerRenglones(trx, tenantId, [...new Set(pendientes.map((p) => p.contrato))]);
  const intereses = await calcularIntereses(trx, tenantId, renglones, [...new Set(pendientes.map((p) => p.periodo))]);
  for (const p of pendientes) {
    const r = renglones.find((x) => x.renglon_id === p.renglon);
    const calc = r ? importeCalculado(r, intereses.get(p.contrato), p.periodo) : null;
    if (!calc || !('importe' in calc)) {
      out.sin_calculo.push({ allocation_id: p.allocation_id, periodo: p.periodo, motivo: calc && 'motivo' in calc ? calc.motivo : 'El renglón ya no está en un contrato confirmado.' });
      continue;
    }
    if (!(calc.importe > 0) || Math.abs(calc.importe - p.asignado) <= 0.005) continue;
    await ajustarImporteEstimado(trx, actor, p, calc.importe);
    await trx('finance.financial_commitments').where({ id: p.commitment_id }).update({ notes: NOTA_INTERES_CALCULADO });
    await trx('finance.payment_allocation_history').insert({
      tenant_id: tenantId, allocation_id: p.allocation_id, event: EVENTO_RECALCULADO_POR_CONTRATO, status_from: 'pending', status_to: 'pending', created_by: actor,
      detail: JSON.stringify({ regla: 'PGP.219', periodo: p.periodo, antes: p.asignado, despues: calc.importe, calculo: detalleDelCalculo(calc.calculo) }),
    });
    out.recalculados.push({ allocation_id: p.allocation_id, renglon_id: p.renglon, periodo: p.periodo, antes: p.asignado, despues: calc.importe });
  }
  return out;
}

/** Cuando el banco cobra: el cargo del mes queda pagado con su(s) salida(s), por la liga de `[PGP.212]`. */
export async function cerrarCargosCobrados(trx: Knex.Transaction, tenantId: string, actor: string): Promise<ResultadoCierre> {
  const out: ResultadoCierre = { revisados: 0, cerrados: [], esperando: [] };
  if (!(await existe(trx, VISTA_CARGOS_AUTOMATICOS))) return out;
  const pendientes = (await trx.raw(`
    SELECT a.id::text AS allocation_id, a.amount_assigned::float AS asignado, i.id::text AS item_id, fc.id::text AS commitment_id,
           fc.contract_line_id::text AS renglon, fc.period AS periodo, fc.amount_basis AS base, fc.original_amount::float AS original,
           to_char(fc.original_due_date, 'YYYY-MM-DD') AS fecha, l.charges_per_period AS cargos
      FROM finance.payment_allocations a
      JOIN finance.payment_allocation_items i ON i.allocation_id = a.id AND i.obligation_source = 'financial_commitment'
      JOIN finance.financial_commitments fc ON fc.id = i.obligation_id AND fc.contract_line_id IS NOT NULL
      JOIN finance.charge_contract_lines l ON l.id = fc.contract_line_id
     WHERE a.tenant_id = ? AND a.status = 'pending' AND a.paid_bank_movement_id IS NULL
     ORDER BY fc.original_due_date, a.id`, [tenantId])).rows as
    { allocation_id: string; asignado: number; item_id: string; commitment_id: string; renglon: string; periodo: string; base: ReglaImporteCargo; original: number; fecha: string; cargos: number }[];
  out.revisados = pendientes.length;
  if (!pendientes.length) return out;
  const ligadas = new Set(((await trx.raw(SQL_SALIDAS_LIGADAS, [tenantId])).rows as { id: string }[]).map((r) => r.id));
  const movs = (await trx.raw(`
    SELECT bank_movement_id::text AS id, contract_line_id::text AS renglon, to_char(movement_date, 'YYYY-MM-DD') AS fecha, amount::float AS importe
      FROM ${VISTA_CARGOS_AUTOMATICOS}
     WHERE tenant_id = ? AND reason = 'con_contrato' AND contract_line_id = ANY(?::uuid[])
     ORDER BY movement_date, bank_movement_id`, [tenantId, [...new Set(pendientes.map((p) => p.renglon))]])).rows as
    { id: string; renglon: string; fecha: string; importe: number }[];
  const usados = new Set<string>();

  for (const p of pendientes) {
    const desde = masDias(p.fecha, -DIAS_ANTES_DEL_CIERRE), hasta = masDias(p.fecha, DIAS_DESPUES_DEL_CIERRE);
    const cand = movs.filter((m) => m.renglon === p.renglon && !ligadas.has(m.id) && !usados.has(m.id) && m.fecha >= desde && m.fecha <= hasta);
    const cargos = Math.max(1, p.cargos);
    if (cand.length < cargos) {
      out.esperando.push({ allocation_id: p.allocation_id, renglon_id: p.renglon, periodo: p.periodo,
        motivo: cand.length ? `El banco ha cobrado ${cand.length} de ${cargos} cargos de este periodo.` : 'El banco todavía no lo cobra.' });
      continue;
    }
    const tomados = cand.slice(0, cargos);
    const total = redondo(tomados.reduce((t, m) => t + m.importe, 0));
    // Un estimado toma lo que cobró el banco.
    if (p.base === 'estimado' && Math.abs(total - p.asignado) > 0.005) await ajustarImporteEstimado(trx, actor, p, total);
    const n = await trx('finance.payment_allocations')
      .where({ tenant_id: tenantId, id: p.allocation_id, status: 'pending' }).whereNull('paid_bank_movement_id')
      .update({
        status: 'executed', executed_at: trx.fn.now(), paid_bank_movement_id: tomados[0].id, paid_bank_date: tomados[0].fecha,
        paid_bank_amount: total, paid_validated_at: trx.fn.now(), updated_by: actor, updated_at: trx.fn.now(),
      });
    if (!n) continue;
    for (const m of tomados) usados.add(m.id);
    await trx('finance.payment_allocation_history').insert({
      tenant_id: tenantId, allocation_id: p.allocation_id, event: EVENTO_PAGADO_POR_CONTRATO, status_from: 'pending', status_to: 'executed', created_by: actor,
      detail: JSON.stringify({
        regla: 'PGP.211', periodo: p.periodo, base: p.base, planeado: { fecha: p.fecha, importe: p.asignado },
        banco: { movimiento: tomados[0].id, fecha: tomados[0].fecha, importe: total, ...(tomados.length > 1 ? { grupo: tomados.map((m) => m.id) } : {}) },
      }),
    });
    await recalcularObligacion(trx, 'financial_commitment', p.commitment_id);
    out.cerrados.push({ allocation_id: p.allocation_id, renglon_id: p.renglon, periodo: p.periodo, importe: total, movimientos: tomados.map((m) => m.id), base: p.base });
  }
  return out;
}
