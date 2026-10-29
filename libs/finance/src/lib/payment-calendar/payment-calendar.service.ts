import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ObjectStorageService } from '@megadulces/platform-core';
import { BUDGET_LEDGER_PORT, type BudgetLedgerPort } from '../budget/budget-ledger.port';
import { GRUPOS_FINANCIEROS, PREFIJOS_FINANCIEROS } from '../creditor-statements/creditor-statements.engine';
import { sqlKeplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';
import { sqlVentanaProntoPago } from '@megadulces/contracts/finance/pronto-pago-ventana';
import type { PayableEvidenceFile, PayableEvidenceRow, PaymentCalendarAllocation, PaymentCalendarWeek, PaymentOriginAccount, SupplierCreditRow, SupplierPaymentHabit, SupplierUnappliedCreditRow } from '@megadulces/contracts';

export type ObligationSource = 'budget_expense' | 'financial_commitment' | 'supplier_payable' | 'kepler_payable';

/**
 * `[TP.18.7]` La llave del origen derivado vive en `shared/`: la usan el Calendario y Pronto
 * pago, y tener una función pura dentro de un servicio obligaba al otro módulo a importar el
 * servicio entero (ADR-056). Se re-exporta porque ya hay código y pruebas que la toman de acá.
 */
export { keplerPayableId, sqlKeplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';
const KEPLER_PAYABLE_ID = sqlKeplerPayableId('v');

/**
 * `[TP.17.1b]` **Un crédito bancario no es mercancía** (ADR-094 §7).
 *
 * La deuda derivada trae TODO lo que el ERP debe, y ahí adentro hay dos naturalezas que el
 * Calendario trata distinto: medido el 2026-10-16, **41 documentos por $38,012,268** son créditos
 * BBVA y BanBajío, préstamos de personas físicas y tarjetas — contra 2,870 de proveedor. Si entran
 * como `proveedor_mercancia`, un crédito se puede agrupar en el mismo pago que una factura de
 * dulces y **pierde su lugar en el orden** (los compromisos financieros se pagan primero).
 *
 * ⛔ **El criterio NO se reescribe acá**: es el de `clasificarAcreedor()` del Estado de Cuenta de
 * Acreedores, que ya está en producción. Lo que se hace es **generar el SQL desde sus mismas
 * constantes**, para que agregar un prefijo o un grupo en el engine cambie también esta consulta.
 * Una copia a mano sería la sexta familia de constantes duplicadas del repo.
 *
 * ⚠️ Lo que **sí** es decisión de esta fase, y queda dicha: `servicios` y `sin_clasificar` van a
 * `proveedor_mercancia`. No es que sean mercancía — es que **se pagan por el mismo circuito** (una
 * factura del ERP a un tercero). Los `interno` (`TI*`) ya quedaron fuera: no son deuda.
 *
 * ── `[PGP.18]` **El gasto deja de ser una categoría vacía** ───────────────────────────────────
 *
 * Esta nota decía que `gasto` quedaba *«reservado para lo que autorizó Presupuestos por su propio
 * camino»*. Medido el 2026-10-26, ese camino está **vacío**: `budget.expense_obligations` tiene
 * **312 filas y las 312 son `propuesta`** —proyecciones mensuales del presupuesto hasta 2027
 * («GASTOS DE VENTA 2027-11»), $149,664,685, ninguna autorizada— y el Calendario las excluye, con
 * razón: no son deuda, son un plan.
 *
 * ⛔ El resultado era que **el filtro «Gasto» nunca devolvía nada** mientras **1,089 gastos reales
 * por $5,991,839** —ARRENDAMEX, caja chica, SERVICIOS LA QUEMADA— salían rotulados «Proveedor».
 * Un filtro que siempre está vacío y una etiqueta que nombra otra cosa: el defecto que
 * `auditoria-diseno` llama Cruce 2.
 *
 * El criterio **no se inventa**: es el nombre que el propio ERP le da al documento. `kdmm` del
 * módulo `X` dice que `X-A-10` se llama **«Gastos»**, igual que `X-A-20` es «Aplica Orden Entrada»
 * (mercancía) y `X-A-45` «Nota Cargo a Proveedor».
 *
 * ⚠️ El orden de las ramas importa y está medido: un crédito BBVA llega como `X-A-10` (intereses)
 * y tiene que seguir siendo `compromiso_financiero`. Por eso lo financiero se evalúa **primero**;
 * con ese orden, los 72 documentos financieros ($34,635,405) no se mueven.
 */
function sqlClassificationKepler(codigo: string, grupo: string, docTipo?: string): string {
  const porPrefijo = PREFIJOS_FINANCIEROS.map((p) => `upper(btrim(${codigo})) LIKE '${p}%'`).join(' OR ');
  const porGrupo = GRUPOS_FINANCIEROS.map((g) => `btrim(coalesce(${grupo}, '')) = '${g}'`).join(' OR ');
  // `[PGP.18]` X-A-10 = «Gastos» en el catálogo kdmm del ERP. Sin `docTipo` el comportamiento es
  // exactamente el de antes: la rama no existe y todo lo no financiero cae a proveedor.
  const ramaGasto = docTipo ? `WHEN ${docTipo}::int = 10 THEN 'gasto'::text ` : '';
  return `CASE WHEN (${porGrupo}) OR (${porPrefijo})
               THEN 'compromiso_financiero'::text ${ramaGasto}ELSE 'proveedor_mercancia'::text END`;
}

/**
 * `[TP.16]` Los 7 días (lunes→domingo) de la semana que contiene `date`. Aritmética en UTC sobre
 * la fecha civil: no hay hora de por medio, así que la zona horaria no puede correr el día.
 */
export function weekDates(date: string): string[] {
  const [y, m, d] = date.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const monday = new Date(base);
  monday.setUTCDate(base.getUTCDate() - ((base.getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(monday);
    x.setUTCDate(monday.getUTCDate() + i);
    return x.toISOString().slice(0, 10);
  });
}

/**
 * `[TP.16]` Dígito de control de una CLABE (Banxico): pesos 3·7·1 sobre los primeros 17 dígitos,
 * se suma `(dígito × peso) mod 10`, y el control es `(10 − suma mod 10) mod 10`.
 */
export function clabeValida(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const pesos = [3, 7, 1];
  let suma = 0;
  for (let i = 0; i < 17; i++) suma += (Number(clabe[i]) * pesos[i % 3]) % 10;
  return (10 - (suma % 10)) % 10 === Number(clabe[17]);
}

/**
 * `[TP.16]` ¿El pago trae lo que Caja General necesita para dispersarlo? Método, y además origen
 * (transferencia / cargo automático / cheque) y destino (transferencia). Un pago preparado ANTES de
 * TP.16 tiene método pero no origen: no cuenta como preparado. El front (`unpreparedCount`) usa la
 * misma regla; si cambia una, cambia la otra.
 */
export function isPrepared(a: { payment_method: string | null; bank_account_id?: string | null; destination_account_text?: unknown }): boolean {
  if (!a.payment_method) return false;
  if (a.payment_method !== 'efectivo' && !a.bank_account_id) return false;
  if (a.payment_method === 'transferencia' && !String(a.destination_account_text ?? '').trim()) return false;
  return true;
}

/**
 * `[TP.16.3]` Lo que tiene que ser IGUAL en todas las facturas de un mismo pago (Francisco,
 * 2026-10-16): **el beneficiario** (un pago es UNA transferencia a UNA cuenta) y **la sucursal**
 * (el pago entra al centro de costo de cada almacén: un proveedor con operaciones en 3 sucursales
 * se paga junto sólo dentro del mismo almacén). La sucursal sólo existe hoy en la factura de
 * proveedor (`kepler_sucursal`, TP.15); gastos y compromisos no la traen y cuentan como «sin
 * sucursal», que tampoco se mezcla con una conocida.
 */
export function paymentGroupKey(source: string, row: { supplier_id?: string | null; beneficiary?: string | null; kepler_sucursal?: string | null }): { payee: string; branch: string } {
  // `[TP.18]` La deuda derivada de Kepler agrupa IGUAL que la capturada: las dos son facturas del
  // mismo proveedor y la misma sucursal, y un pago las puede cubrir juntas (ADR-094 §5).
  const esFactura = source === 'supplier_payable' || source === 'kepler_payable';
  const payee = esFactura ? `s:${row.supplier_id ?? ''}` : `b:${String(row.beneficiary ?? '').trim().toUpperCase()}`;
  const suc = esFactura ? String(row.kepler_sucursal ?? '').trim() : '';
  const branch = suc || 'sin sucursal';
  return { payee, branch };
}

/** Renglón de `finance.payment_allocation_items` — sólo los campos que este servicio lee (`[NX.11]`). */
interface AllocationItemRow {
  id: string;
  obligation_source: ObligationSource;
  obligation_id: string;
  applied_amount: number | string;
}

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `[TP.18]` `null` = el origen **no tiene tabla propia**: es derivado de una vista del ERP y su
 * saldo se calcula al vuelo. Todo lo que lee o escribe una obligación tiene que preguntar por esto
 * antes de tocar una tabla — por eso el tipo lo obliga (`string | null`) en vez de dejarlo afuera.
 */
const TABLE_BY_SOURCE: Record<ObligationSource, string | null> = {
  budget_expense: 'budget.expense_obligations',
  financial_commitment: 'finance.financial_commitments',
  supplier_payable: 'commercial.supplier_payment_obligations',
  kepler_payable: null,
};
const CLASSIFICATION_BY_SOURCE: Record<ObligationSource, string> = {
  budget_expense: 'gasto',
  financial_commitment: 'compromiso_financiero',
  supplier_payable: 'proveedor_mercancia',
  // ⚠️ Sólo el FALLBACK del origen derivado. Su clasificación real sale de la FILA
  // (`[TP.17.1b]`: un crédito bancario es `compromiso_financiero`), y se lee con
  // {@link classificationOf} — nunca de este mapa directamente.
  kepler_payable: 'proveedor_mercancia',
};

/**
 * `[TP.17.1b]` La clasificación de una obligación. Para los tres orígenes con tabla la fija el
 * origen; para el derivado **la trae la fila**, porque un mismo origen entrega facturas de
 * proveedor y créditos bancarios, que no se pagan juntos ni en el mismo orden.
 */
function classificationOf(source: ObligationSource, row: { classification?: unknown }): string {
  if (source !== 'kepler_payable') return CLASSIFICATION_BY_SOURCE[source];
  const c = String(row.classification ?? '').trim();
  return c || CLASSIFICATION_BY_SOURCE.kepler_payable;
}

export interface AllocationItemDto { obligation_source: ObligationSource; obligation_id: string; applied_amount: number }
export interface CreateAllocationDto { date: string; items: AllocationItemDto[]; priority_rank?: number | null; notes?: string | null }
export interface PrepareAllocationDto {
  payment_method: 'transferencia' | 'cheque' | 'efectivo' | 'cargo_automatico';
  bank_account_id?: string | null; destination_account_text?: string | null;
  cash_register_text?: string | null; reference_text?: string | null;
  supplier_payment_account_id?: string | null;
}
/** `[TP.16]` Renglón de `finance.payment_allocations` — sólo lo que la vista del día y la autorización leen. */
interface AllocationRowLite {
  id: string; bank_account_id: string | null; amount_assigned: number | string; payment_method: string | null;
  [col: string]: unknown;
}
/** `[TP.15]` Lo que el candado de saldo lee de una obligación a proveedor (columnas de la mig 20261016002604). */
interface KeplerLinkedRow {
  supplier_id?: string; reserved_amount: number | string;
  kepler_sucursal?: string | null; kepler_folio?: string | null;
  kepler_doc_tipo?: number | string | null; kepler_doc_sub?: number | string | null;
}
export type ReprogramReason = 'cuenta_erronea' | 'falla_sistema_banco' | 'pago_devuelto' | 'presupuesto_recortado' | 'otro';
export const REPROGRAM_REASONS: ReprogramReason[] = ['cuenta_erronea', 'falla_sistema_banco', 'pago_devuelto', 'presupuesto_recortado', 'otro'];
// TP.6 — un lote AUTORIZADO (o más adelante) ya cerró su alcance: no admite nuevos pagos.
// Reprogramar/fallar/ejecutar una allocation EXISTENTE sigue permitido (son hechos de ejecución,
// no de autorización) — lo que se bloquea es agregar pagos NUEVOS al lote ya autorizado.
const LOCKED_LOT_STATUSES = new Set(['released', 'executing', 'closed']);
export interface CreateAgreementDto {
  obligation_source: ObligationSource; obligation_id: string;
  responsible_user?: string | null; counterpart_text?: string | null;
  committed_date?: string | null; committed_amount?: number | null;
  allows_partial?: boolean; evidence_url?: string | null; notes?: string | null;
}

/**
 * Fase TP.1 — El motor de asignación del Calendario de Pagos (ADR-064). SOLO LEE las tres tablas
 * de origen (`budget.expense_obligations` / `finance.financial_commitments` /
 * `commercial.supplier_payment_obligations`) — nunca las crea. Reserva por `payment_allocations`
 * + `payment_allocation_items` (polimórfico), y mantiene `reserved_amount`/`paid_amount`/`status`
 * de cada obligación SIEMPRE recalculados desde los items activos (nunca +=/-= manual, para no
 * desincronizar el saldo).
 */
/**
 * `[TP.19.4.1]` Lo que devuelve la sugerencia de Kepler. Son TRES returns distintos en el
 * mismo metodo (ya ligado / sin documentos que ligar / con candidatos), asi que los campos
 * que no estan en los tres van opcionales: una union exacta rompe por exceso de propiedades.
 *
 * ⚠️ `candidatos` va como piso declarado y no con la forma de sus columnas: el SELECT trae mas
 * de las que se pueden leer de un vistazo, y escribir una forma que NO se midio es inventarla.
 * Quien la necesite tipada que la mida primero (ADR-056: lo que no se midio se DECLARA).
 */
export interface SugerenciaKepler {
  ya_ligado: boolean;
  folio?: string | null;
  candidatos: Record<string, unknown>[];
  motivo?: string;
  unico?: boolean;
}
@Injectable()
export class PaymentCalendarService {
  private readonly logger = new Logger(PaymentCalendarService.name);
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(BUDGET_LEDGER_PORT) private readonly ledger?: BudgetLedgerPort,
    // `[PGP.21]` OPCIONAL a proposito: si el cableado falla, muere ESTE endpoint y no el arranque
    // de la API. Es la leccion de #414, que tiro produccion con el CI en verde.
    @Optional() private readonly storage?: ObjectStorageService,
  ) {}

  private assertDate(d: string) {
    if (!DATE_RX.test(d)) throw new BadRequestException('Fecha inválida (YYYY-MM-DD)');
  }

  /** Recalcula reserved_amount/paid_amount/status de UNA obligación desde sus items activos. */
  private async recalcObligation(trx: Knex.Transaction, source: ObligationSource, id: string) {
    const table = TABLE_BY_SOURCE[source];
    // `[TP.18]` El origen derivado no tiene dónde guardar `reserved_amount`/`paid_amount`: su
    // saldo se recalcula al vuelo en cada lectura, desde estos mismos items. No hay nada que
    // desincronizar, que es justamente lo que `recalcObligation` viene a evitar en los otros tres.
    if (!table) return;
    const [agg] = await trx('finance.payment_allocation_items as i')
      .join('finance.payment_allocations as a', 'a.id', 'i.allocation_id')
      .where({ 'i.obligation_source': source, 'i.obligation_id': id })
      .select(
        trx.raw(`coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'pending'), 0) AS reserved`),
        trx.raw(`coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'executed'), 0) AS paid`),
      );
    const row = await trx(table).select('original_amount', 'status').where({ id }).first();
    if (!row) return;
    const reserved = Number(agg?.reserved ?? 0);
    const paid = Number(agg?.paid ?? 0);
    const newStatus = row.status === 'cancelled' ? 'cancelled'
      : paid >= Number(row.original_amount) ? 'paid'
      : (paid > 0 || reserved > 0) ? 'partial' : 'pending';
    await trx(table).where({ id }).update({ reserved_amount: reserved, paid_amount: paid, status: newStatus, updated_at: trx.fn.now() });
  }

  /** Recalcula amount_assigned de UN allocation desde sus items. */
  private async recalcAllocationTotal(trx: Knex.Transaction, allocationId: string) {
    const [{ total }] = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId }).sum({ total: 'applied_amount' });
    await trx('finance.payment_allocations').where({ id: allocationId }).update({ amount_assigned: total ?? 0, updated_at: trx.fn.now() });
  }

  /**
   * `[TP.15]` Una obligación nacida de una entrega guarda la llave de su documento en Kepler: al
   * asignarla se vuelve a medir el pendiente VIVO, porque Kepler pudo registrar un pago o una NC
   * después de que Finanzas aceptó el papel. Tope = pendiente de Kepler − lo ya reservado aquí
   * (lo reservado todavía no se paga, así que Kepler no lo descuenta). Lo ya ejecutado no se resta
   * dos veces: el disponible propio (`original − reservado − pagado`) ya lo limita.
   * Sin llave (capturada a mano, o mig TP.15 sin aplicar) no hay contra qué medir: no limita.
   * ⚠️ Deuda declarada: un pago ya EJECUTADO aquí que Kepler aún no registra, sumado a una NC
   * posterior, deja un tope más alto que la deuda real. Restar también `paid` bloquearía toda
   * parcialidad una vez que Kepler sí registra el pago; sin saber qué pagos ya reflejó Kepler, no
   * hay tope exacto.
   * `alreadyReserved`: al asignar, lo reservado por otros pagos; al ejecutar, 0 (este pago ES la reserva).
   */
  private async assertKeplerBalance(trx: Knex.Transaction, source: ObligationSource, row: KeplerLinkedRow, applied: number,
    alreadyReserved = Number(row.reserved_amount)) {
    // `[TP.18]` Vale para los dos orígenes de factura: la capturada trae las columnas `kepler_*`
    // desde la mig `20261016002604`, y la derivada las trae por construcción.
    if ((source !== 'supplier_payable' && source !== 'kepler_payable') || !row.kepler_folio) return;
    const [doc] = await trx('analytics.v_supplier_payables')
      .where({ sucursal: row.kepler_sucursal, folio: row.kepler_folio, doc_tipo: row.kepler_doc_tipo, doc_sub: row.kepler_doc_sub })
      .whereIn('proveedor', trx('catalog.suppliers').select('code').where({ id: row.supplier_id }))
      .sum({ pendiente: 'pendiente' });
    const pendiente = Number(doc?.pendiente ?? 0);
    const tope = pendiente - alreadyReserved;
    if (applied > tope + 0.005) {
      throw new BadRequestException(pendiente <= 0
        ? 'Kepler ya no tiene saldo pendiente de esta factura (¿se pagó por fuera o tiene nota de crédito?). No se programa ni se ejecuta.'
        : `Excede el saldo pendiente en Kepler (pendiente: ${pendiente.toFixed(2)}, ya reservado en otros pagos: ${alreadyReserved.toFixed(2)}).`);
    }
  }

  /**
   * `[TP.18]` **Una obligación, venga de donde venga** (ADR-094).
   *
   * Los tres orígenes con tabla se leen igual que siempre. El derivado se ARMA con el mismo shape
   * desde `analytics.v_supplier_payables` + lo ya reservado en `payment_allocation_items`, para que
   * `createAllocation`, `addItem` y los agreements no tengan que saber de dónde salió la fila.
   *
   * ⛔ `status` siempre `'pending'`: una factura que Kepler ya no debe **no aparece en la vista**,
   * así que no hay estado `cancelled` que leer — ésa es la diferencia con una obligación nuestra,
   * y por eso el candado de saldo (`assertKeplerBalance`) sigue corriendo igual en cada paso.
   */
  private async loadObligationRow(trx: Knex.Transaction, tenantId: string, source: ObligationSource, id: string) {
    const table = TABLE_BY_SOURCE[source];
    if (table) return trx(table).where({ tenant_id: tenantId, id }).first();
    const [row] = await trx('analytics.v_supplier_payables as v')
      .leftJoin('catalog.suppliers as s', 's.code', 'v.proveedor')
      .whereRaw(`${KEPLER_PAYABLE_ID} = ?`, [id])
      .where('v.tenant_id', tenantId)
      .select(
        trx.raw('? AS id', [id]),
        trx.raw(`'pending'::text AS status`),
        trx.raw('v.pendiente AS original_amount'),
        // `[TP.17.1b]` La clasificación viaja con la fila: para este origen NO sale de
        // `CLASSIFICATION_BY_SOURCE`, porque depende del acreedor y no del origen.
        trx.raw(`${sqlClassificationKepler('v.proveedor', 'v.grupo', 'v.doc_tipo')} AS classification`),
        's.id AS supplier_id',
        trx.raw(`coalesce(s.name, v.proveedor_nombre, v.proveedor) AS beneficiary`),
        trx.raw(`coalesce(nullif(btrim(v.folio), ''), 'Factura') AS concept`),
        'v.sucursal AS kepler_sucursal', 'v.folio AS kepler_folio',
        'v.doc_tipo AS kepler_doc_tipo', 'v.doc_sub AS kepler_doc_sub',
      );
    if (!row) return undefined;
    // Lo ya comprometido sale de los items, que son la fuente de verdad de la reserva para los
    // CUATRO orígenes — acá, además, es el único lugar donde existe.
    const [agg] = await trx('finance.payment_allocation_items as i')
      .join('finance.payment_allocations as a', 'a.id', 'i.allocation_id')
      .where({ 'i.obligation_source': source, 'i.obligation_id': id })
      .select(
        trx.raw(`coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'pending'), 0) AS reserved`),
        trx.raw(`coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'executed'), 0) AS paid`),
      );
    return { ...row, reserved_amount: Number(agg?.reserved ?? 0), paid_amount: Number(agg?.paid ?? 0) };
  }

  private async getOrCreateLot(trx: Knex.Transaction, tenantId: string, date: string) {
    let lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
    if (!lot) [lot] = await trx('finance.payment_calendar_lots').insert({ tenant_id: tenantId, lot_date: date }).returning('*');
    return lot;
  }

  // ── Obligaciones disponibles (UNION de los 3 orígenes; nunca escribe) ────────────────
  /**
   * `[PGP.14]` **El crédito a favor que nadie aplicó, por acreedor.**
   *
   * Nace de una pregunta de Edgar (2026-10-26): *«¿cómo sabemos cuándo debemos aplicar una nota de
   * crédito o alguna devolución?»*. Medido: **Kepler ya las aplica** —`kdxf` casa el abono contra
   * el cargo y la deuda viva nace neteada—, así que la pantalla pagaba bien… salvo por lo que
   * **nadie aplicó**, que era invisible: `v_supplier_payables` sólo deja pasar cargos.
   *
   * | | medido el 2026-10-26 |
   * |---|---|
   * | sin aplicar, total | **$8,264,176** en 201 documentos |
   * | de eso, **neteable hoy** | **$4,484,249** en **54 acreedores con deuda viva** |
   * | el resto | 15 acreedores sin deuda viva ($2.95 M): no hay contra qué aplicarlo |
   *
   * ⭐ Las **notas de crédito sí se aplican** (1,801 docs, $110.6 M, ~100 %). Lo que se queda son
   * **anticipos** ($6.99 M) y **devoluciones** ($1.25 M, 6 de cada 10 sin netear).
   *
   * ⚠️ **Es un PISO, no un dictamen**: el control de cheques da 105 % aplicado (`kdxf` sobre-cuenta
   * por replicación de sucursal), y sobre-contar lo aplicado **sub-cuenta** lo pendiente.
   *
   * Sale en su propio endpoint y no dentro de `listObligations` a propósito: esa consulta tiene un
   * presupuesto de 500 ms y corre en 325-377: meterle este join la empuja contra el techo sin que
   * nadie lo necesite en la misma respuesta. Medido: 135-143 ms por separado.
   */
  async listUnappliedCredits(): Promise<SupplierUnappliedCreditRow[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      /*
       * ⛔ `[PGP.17]` **El `EXISTS` correlacionado costaba 882 ms; este `LEFT JOIN`, 394.**
       *
       * Medido contra prod el 2026-10-26, 4 corridas cada uno. La versión con `EXISTS (…)` dentro
       * del `SELECT` lo evaluaba **una vez por acreedor** —73 veces— contra una vista derivada que
       * no tiene índice que ayude. Pre-agregar los acreedores con deuda a un conjunto y unirlo lo
       * deja en una sola pasada.
       *
       * ⚠️ 394 ms sigue siendo cerca del techo de 500. Se banca porque corre **una vez al abrir la
       * pantalla** y en paralelo con las obligaciones, no por interacción. Si la deuda crece, el
       * siguiente paso es materializar `ap` — no subir el techo.
       */
      const { rows } = await trx.raw(
        `WITH deudores AS (
           SELECT DISTINCT p.proveedor
             FROM analytics.v_supplier_payables p
            WHERE p.pendiente > 0 AND p.proveedor NOT LIKE 'TI%' AND p.tenant_id = ?
         )
         SELECT c.proveedor,
                max(c.proveedor_nombre) AS proveedor_nombre,
                sum(c.a_favor)::float8 AS a_favor,
                count(*)::int AS docs,
                string_agg(DISTINCT c.clase, ', ' ORDER BY c.clase) AS clases,
                to_char(min(c.fecha), 'YYYY-MM-DD') AS mas_vieja,
                bool_or(d.proveedor IS NOT NULL) AS con_deuda_viva
           FROM analytics.v_supplier_credits c
           LEFT JOIN deudores d ON d.proveedor = c.proveedor
          WHERE c.tenant_id = ? AND c.pendiente
          GROUP BY c.proveedor
          ORDER BY sum(c.a_favor) DESC`,
        [tenantId, tenantId],
      );
      return rows;
    });
  }

  /**
   * `[PGP.17]` **El desglose de UN acreedor, con los DOS casos.** Pedido de Edgar: *«especificando
   * todo tipo de descuento para que sepan qué aplicar desde Suite»*.
   *
   * El aviso de `[PGP.14]` dice *cuánto* hay a favor; esto dice **de qué tipo, de qué documento y
   * si ya se aplicó o no** — que es lo único con lo que alguien puede ir a actuar.
   *
   * ⭐ Devuelve también lo YA APLICADO, a propósito. Sin eso, quien mira cree que el sistema no
   * hace nada: el caso real de `CL005` es una nota de crédito de $2,649,765.94 de la que Kepler
   * aplicó $2,173,299.73 **solo**, y por eso esa factura nunca apareció en la pantalla de Pagos.
   * Ver sólo lo pendiente convierte un proceso que funciona en una sospecha.
   *
   * ⛔ Pagos (cheque `X-D-25`, transferencia `X-D-26`) quedan fuera: no son descuentos.
   */
  async listSupplierCredits(proveedor: string): Promise<SupplierCreditRow[]> {
    const code = String(proveedor ?? '').trim();
    if (!code) return [];
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT c.sucursal, c.clase, c.folio, c.referencia,
                to_char(c.fecha, 'YYYY-MM-DD') AS fecha,
                c.importe::float8 AS importe, c.aplicado::float8 AS aplicado,
                c.a_favor::float8 AS a_favor, c.pendiente
           FROM analytics.v_supplier_credits c
          WHERE c.tenant_id = ? AND c.proveedor = ?
          ORDER BY c.pendiente DESC, c.fecha DESC NULLS LAST, c.a_favor DESC
          LIMIT 200`,
        [tenantId, code],
      );
      return rows;
    });
  }

  /**
   * `[PGP.19]` La evidencia documental de los documentos de UN acreedor.
   *
   * ⛔ Va aparte de `obligations` y se pide en diferido: la vista tiene un piso MEDIDO de ~2.2-2.5 s que
   *    NO baja al filtrar (es el costo de armar el hash sobre los 169 mil CFDI recibidos), y
   *    `obligations` ya consume 325-377 ms de su presupuesto de 500 ms.
   * ⛔ No se expone el filtro por sucursal: medido en 1,082-1,179 ms, pasa el tope.
   */
  async listPayableEvidence(proveedor: string): Promise<PayableEvidenceRow[]> {
    const code = String(proveedor ?? '').trim();
    if (!code) return [];
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT e.sucursal, e.doc_tipo, e.doc_sub, e.folio, e.proveedor,
                'oblig:' || e.sucursal || '|' || e.doc_tipo || '|' || e.doc_sub || '|' || btrim(e.folio) AS entity_ref,
                e.pendiente::float8 AS pendiente, e.evidencia, e.ref_evidencia,
                e.puntaje, e.senales, e.motivo, e.rfc, e.rfc_fuente, e.rfc_discrepa
           FROM analytics.v_payable_evidence e
          WHERE e.tenant_id = ? AND e.proveedor = ?
          ORDER BY e.evidencia, e.puntaje DESC, e.pendiente DESC
          LIMIT 500`,
        [tenantId, code],
      );
      return rows;
    });
  }

  /**
   * `[PGP.21]` La evidencia de UNA LISTA de documentos, en UNA sola consulta.
   *
   * ⛔ Esta es la forma correcta de pedirla, y la razon es medida: la vista tiene un piso de
   *    ~2.2-2.5 s que NO baja con ningun filtro (es armar el hash sobre los 169 mil CFDI). Una
   *    llamada por proveedor multiplicaria ese piso por la cantidad de acreedores en pantalla.
   * ⚠️ Tope de 200 refs por llamada: arriba de eso la pantalla deberia paginar, no pedir mas.
   */
  async listEvidenceByRefs(refs: readonly string[]): Promise<PayableEvidenceRow[]> {
    const llaves = (refs ?? [])
      .map((r) => String(r ?? '').trim())
      .filter((r) => r.startsWith('oblig:'))
      .map((r) => r.slice('oblig:'.length))
      .slice(0, 200);
    if (!llaves.length) return [];
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT e.sucursal, e.doc_tipo, e.doc_sub, e.folio, e.proveedor,
                'oblig:' || e.sucursal || '|' || e.doc_tipo || '|' || e.doc_sub || '|' || btrim(e.folio) AS entity_ref,
                e.pendiente::float8 AS pendiente, e.evidencia, e.ref_evidencia,
                e.puntaje, e.senales, e.motivo, e.rfc, e.rfc_fuente, e.rfc_discrepa
           FROM analytics.v_payable_evidence e
          WHERE e.tenant_id = ?
            AND (e.sucursal || '|' || e.doc_tipo || '|' || e.doc_sub || '|' || btrim(e.folio)) = ANY(?)`,
        [tenantId, llaves],
      );
      return rows;
    });
  }

  /**
   * `[PGP.21]` Los archivos de UN comprobante, firmados para abrir.
   *
   * ⛔ Vive aca y no se enlaza al endpoint de Compras: medido el 2026-10-27, 3 de los 32 roles
   *    que ven Pagos no tienen COMPRAS_ENTRADAS_VER, y uno es `finanzas_operativo` (Tesoreria).
   */
  async getEvidenceFiles(proofId: string): Promise<PayableEvidenceFile[]> {
    const id = String(proofId ?? '').trim();
    if (!id) return [];
    const tenantId = this.tenantCtx.requireTenantId();
    const fila = await this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT files FROM finance.goods_receipt_proofs WHERE tenant_id = ? AND id = ?::uuid`,
        [tenantId, id],
      );
      return rows?.[0] ?? null;
    });
    if (!fila) throw new NotFoundException('No encontre ese comprobante');
    const files = Array.isArray(fila.files) ? fila.files : [];
    // Sin almacen no se inventa una URL: se declara que no se puede abrir (ADR-056).
    if (!this.storage) {
      throw new ServiceUnavailableException(
        'El almacen de archivos no esta disponible; no puedo abrir la factura ahora.');
    }
    const firmados = await this.storage.signFiles(files as { url?: string; public_id?: string }[]);
    return firmados.map((f) => {
      const x = f as { url?: string; name?: string; role?: string; kind?: string };
      return { url: x.url ?? '', name: x.name ?? null, role: x.role ?? null, kind: x.kind ?? null };
    }).filter((f) => f.url);
  }

  async listObligations(q: {
    source?: ObligationSource; classification?: string; search?: string;
    dueFrom?: string; dueTo?: string; onlyCritical?: boolean; onlyAvailable?: boolean;
    limit?: number; offset?: number;
    /** [TP.20.4] Solo facturas cuyo descuento por pronto pago esta por vencer o aun es capturable. */
    prontoPago?: 'por_vencer' | 'capturable';
    /**
     * `[PGP.7]` **Con qué urgencia se lee la lista.** Era la ultima razon para tener Pronto pago
     * como pantalla aparte: el inventario de §23 midio que las dos listas ordenan al reves y
     * concluyo que fusionarlas rompia una. Lo que rompia era imponer UN orden; ofrecer los dos
     * no rompe ninguno.
     *
     *  · `vencimiento` (default) — cuando hay que pagar. El orden de siempre, intacto.
     *  · `descuento` — cuando se pierde el privilegio. Es el orden de Pronto pago, y su encabezado
     *    decia que «el orden ES la mitad del valor»: por fecha limite del descuento y, a igualdad,
     *    por lo que se gana.
     */
    orden?: 'vencimiento' | 'descuento';
  }) {
    // `[TP.17.2]` 1000 era el techo fijo de antes: se conserva como default para no cambiar lo que
    // ya veía la pantalla, pero ahora se puede mover y, sobre todo, se sabe cuánto quedó afuera.
    // ⚠️ Un valor inválido (negativo, cero, NaN) cuenta como NO ESPECIFICADO y cae al default.
    // Con `Math.max(n, 1)` un `limit=-5` devolvía **una sola fila** — una lista casi vacía que
    // parece un día sin deuda. Fallar hacia el default es lo único que no miente.
    const limitRaw = Number(q.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 1000;
    const offsetRaw = Number(q.offset);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    // `[TP.18]` El tenant se NOMBRA acá: las tres patas con tabla van por RLS, pero la cuarta lee
    // `analytics.*`, que **no tiene RLS** — su alcance lo da este filtro explícito y nada más.
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const cols = [
        'obligation_source', 'obligation_id', 'beneficiary', 'concept', 'classification', 'subtype',
        'area_code', 'original_due_date', 'negotiated_date', 'original_amount', 'reserved_amount',
        'paid_amount', 'available_amount', 'is_critical', 'critical_reason', 'authorized_by',
        'authorized_at', 'status', 'notes', 'created_at', 'branch_code', 'payee_id',
        // [TP.20.4] la ventana de pronto pago viaja con la fila
        'pronto_fecha_limite', 'pronto_tasa', 'pronto_beneficio', 'pronto_estado',
        // [TP.20.5] el ref de la ficha. NULL en los orígenes que no tienen documento de Kepler
        // detrás: un ref inventado abriría un panel que no existe.
        'entity_ref',
        /**
         * `[PGP.12]` **La referencia del proveedor y el código del acreedor, para VER y BUSCAR.**
         *
         * `doc_ref` es lo que `/compras/obligaciones` llama «Referencia» (`0-F-2525`, `30-1402`):
         * verificado contra las 38 obligaciones capturadas a mano, **38 de 38 exactas** y control
         * placebo de **0 de 38**. ⚠️ Es captura LIBRE: 92.6 % trae algo, y entre ese algo hay
         * `LPA`, `DAMASO`, `S/R`. Por eso se rotula «Referencia», nunca «Factura».
         *
         * `payee_code` es el código del acreedor (`CNFR001`, `AE002`): Tesorería conoce a varios
         * proveedores por código y hasta hoy no se podía buscar por él.
         */
        'doc_ref', 'payee_code',
      ];
      const legBudget = trx('budget.expense_obligations as o').select(
        trx.raw(`'budget_expense'::text AS obligation_source`), 'o.id AS obligation_id',
        'o.beneficiary', 'o.concept', trx.raw(`'gasto'::text AS classification`), 'o.subtype',
        'o.area AS area_code', 'o.original_due_date', 'o.negotiated_date', 'o.original_amount',
        'o.reserved_amount', 'o.paid_amount',
        trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'),
        'o.is_critical', 'o.critical_reason', 'o.authorized_by', 'o.authorized_at', 'o.status', 'o.notes', 'o.created_at', trx.raw('NULL::text AS branch_code'), trx.raw('NULL::uuid AS payee_id'),
        trx.raw('NULL::date AS pronto_fecha_limite'), trx.raw('NULL::numeric AS pronto_tasa'), trx.raw('NULL::numeric AS pronto_beneficio'), trx.raw("'sin_medir'::text AS pronto_estado"), trx.raw('NULL::text AS entity_ref'),
        // [PGP.12] Un gasto presupuestado no tiene documento de proveedor ni código de acreedor.
        // Se declaran NULL: la columna sale vacía, que es distinto de salir con un hueco inventado.
        trx.raw('NULL::text AS doc_ref'), trx.raw('NULL::text AS payee_code'),
      ).whereNotIn('o.status', ['cancelled', 'propuesta']); // propuesta = sin autorizar → fuera del Calendario (PR.3)

      const legCommitment = trx('finance.financial_commitments as o').select(
        trx.raw(`'financial_commitment'::text AS obligation_source`), 'o.id AS obligation_id',
        'o.beneficiary', 'o.concept', trx.raw(`'compromiso_financiero'::text AS classification`), 'o.subtype',
        trx.raw('NULL::text AS area_code'), 'o.original_due_date', 'o.negotiated_date', 'o.original_amount',
        'o.reserved_amount', 'o.paid_amount',
        trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'),
        'o.is_critical', 'o.critical_reason', 'o.authorized_by', 'o.authorized_at', 'o.status', 'o.notes', 'o.created_at', trx.raw('NULL::text AS branch_code'), trx.raw('NULL::uuid AS payee_id'),
        trx.raw('NULL::date AS pronto_fecha_limite'), trx.raw('NULL::numeric AS pronto_tasa'), trx.raw('NULL::numeric AS pronto_beneficio'), trx.raw("'sin_medir'::text AS pronto_estado"), trx.raw('NULL::text AS entity_ref'),
        // [PGP.12] Un compromiso financiero tampoco tiene documento de proveedor detrás.
        trx.raw('NULL::text AS doc_ref'), trx.raw('NULL::text AS payee_code'),
      ).whereNotIn('o.status', ['cancelled']);

      const legSupplier = trx('commercial.supplier_payment_obligations as o')
        .join('catalog.suppliers as s', 's.id', 'o.supplier_id')
        .select(
          trx.raw(`'supplier_payable'::text AS obligation_source`), 'o.id AS obligation_id',
          's.name AS beneficiary', trx.raw(`coalesce(o.concept, o.invoice_folio, 'Mercancía')::text AS concept`),
          trx.raw(`'proveedor_mercancia'::text AS classification`), trx.raw(`'mercancia'::text AS subtype`),
          's.code AS area_code', 'o.original_due_date', 'o.negotiated_date', 'o.original_amount',
          'o.reserved_amount', 'o.paid_amount',
          trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'),
          's.is_critical', 's.critical_reason', 'o.authorized_by', 'o.authorized_at', 'o.status', 'o.notes', 'o.created_at', trx.raw("nullif(btrim(o.kepler_sucursal), '') AS branch_code"), 'o.supplier_id AS payee_id',
          trx.raw('NULL::date AS pronto_fecha_limite'), trx.raw('NULL::numeric AS pronto_tasa'), trx.raw('NULL::numeric AS pronto_beneficio'), trx.raw("'sin_medir'::text AS pronto_estado"),
          // [TP.20.5] La obligacion CAPTURADA por Entregas tambien tiene ficha, pero solo si
          // alguien le anoto el documento de Kepler. Sin esos cuatro campos no hay a que apuntar.
          trx.raw(`CASE WHEN o.kepler_sucursal IS NOT NULL AND o.kepler_folio IS NOT NULL
                        THEN 'oblig:' || o.kepler_sucursal || '|' || o.kepler_doc_tipo || '|'
                                      || o.kepler_doc_sub || '|' || btrim(o.kepler_folio) END AS entity_ref`),
          // [PGP.12] Acá la referencia ya existía con otro nombre: es la factura que Compras
          // capturó al recibir. Las 38 filas vivas la traen, y son las mismas con las que se
          // verificó que `kdxe.c16` es este dato (38 de 38 exactas).
          trx.raw(`nullif(btrim(o.invoice_folio), '') AS doc_ref`), 's.code AS payee_code',
        ).whereNotIn('o.status', ['cancelled']);

      /**
       * `[TP.18]` **La deuda viva de Kepler que NO pasó por Entregas** (ADR-094) — servicios,
       * fletes, y toda factura que nadie capturó. Medido el 2026-10-16: la puerta de Entregas
       * dejaba afuera el **98 %** de la deuda ($136.3 M contra $2.7 M).
       *
       * Tres recortes, y los tres están medidos:
       *  · `TI*` fuera — son las sucursales dadas de alta como proveedor: traspaso entre almacenes,
       *    **no deuda** (58 docs · $1,155,161 que inflaban el denominador).
       *  · `NOT EXISTS` contra lo capturado — las 37 obligaciones de `[TP.15]` traen la llave
       *    `kepler_*` completa y **las 37 casan**: sin esto serían 37 duplicados exactos.
       *  · la reserva sale de los items (no de una columna), que es lo único que existe acá.
       *
       * ⚠️ La pantalla DEBE paginar: medido, 2,890 filas tardan 613 ms sin límite y 325–377 ms con
       * `ORDER BY … LIMIT 200`. La regla dura son 500 ms.
       */
      const legKepler = trx('analytics.v_supplier_payables as v')
        .leftJoin('catalog.suppliers as s', 's.code', 'v.proveedor')
        /**
         * `[TP.20.4]` **La urgencia del descuento, donde se arma el día.**
         *
         * El inventario de §23 descartó fusionar Pronto pago con esta pantalla: ordenan y agrupan
         * al revés, y fusionarlas rompía una de las dos. Lo que sí viaja son **los tres campos que
         * deciden** — hasta cuándo conviene pagar, cuánto se gana y en qué estado está la ventana.
         *
         * ⛔ La regla **no se reimplementa**: sale de `sqlVentanaProntoPago()`, la misma que usa
         * Pronto pago. Si mañana cambia el mínimo de observaciones, cambia en las dos.
         */
        .leftJoin('analytics.mv_supplier_prompt_discount as d', 'd.proveedor_code', 'v.proveedor')
        // `[TP.18.5]` Lo reservado se agrega **una vez** y se une por id. Era un LATERAL, que es
        // lo natural de escribir y costaba 2,892 evaluaciones para leer un puñado de filas:
        // medido contra prod, 476 ms de mediana contra 399 así (−16 %).
        .joinRaw(`LEFT JOIN (
          SELECT i.obligation_id,
                 coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'pending'), 0) AS reserved,
                 coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'executed'), 0) AS paid
            FROM finance.payment_allocation_items i
            JOIN finance.payment_allocations a ON a.id = i.allocation_id
           WHERE i.obligation_source = 'kepler_payable'
           GROUP BY i.obligation_id
        ) r ON r.obligation_id = ${KEPLER_PAYABLE_ID}`)
        .where('v.tenant_id', tenantId)
        .whereRaw(`v.proveedor NOT LIKE 'TI%'`)
        .whereNotExists(function () {
          this.select(trx.raw('1')).from('commercial.supplier_payment_obligations as o')
            .whereRaw('o.kepler_sucursal = v.sucursal AND o.kepler_doc_tipo = v.doc_tipo')
            .whereRaw('o.kepler_doc_sub = v.doc_sub AND o.kepler_folio = v.folio')
            .whereNot('o.status', 'cancelled');
        })
        .select(
          trx.raw(`'kepler_payable'::text AS obligation_source`), trx.raw(`${KEPLER_PAYABLE_ID} AS obligation_id`),
          trx.raw(`coalesce(s.name, v.proveedor_nombre, v.proveedor) AS beneficiary`),
          trx.raw(`coalesce(nullif(btrim(v.folio), ''), 'Factura') AS concept`),
          // `[TP.17.1b]` La clasificación sale de QUIÉN es el acreedor, no del origen: un crédito
          // bancario y una factura de dulces llegan por la misma vista y no se pagan igual.
          trx.raw(`${sqlClassificationKepler('v.proveedor', 'v.grupo', 'v.doc_tipo')} AS classification`),
          // `[PGP.18]` El subtipo sigue a la clasificación: un gasto no es «mercancía». Si no lo
          // siguiera, el filtro diría «Gasto» y el renglón seguiría diciendo mercancía debajo.
          trx.raw(`CASE ${sqlClassificationKepler('v.proveedor', 'v.grupo', 'v.doc_tipo')}
                        WHEN 'compromiso_financiero' THEN 'financiero'::text
                        WHEN 'gasto' THEN 'operativo'::text
                        ELSE 'mercancia'::text END AS subtype`),
          trx.raw('v.proveedor AS area_code'), trx.raw('v.vencimiento AS original_due_date'),
          trx.raw('NULL::date AS negotiated_date'), trx.raw('v.pendiente AS original_amount'),
          // ⚠️ `coalesce` acá y no dentro del agregado: con LEFT JOIN, una factura SIN reserva no
          // trae fila de `r`, así que `r.reserved` es NULL y `pendiente - NULL` sería NULL — el
          // disponible desaparecería justo en las ~2,890 facturas que nadie programó todavía.
          trx.raw('coalesce(r.reserved, 0) AS reserved_amount'), trx.raw('coalesce(r.paid, 0) AS paid_amount'),
          trx.raw('(v.pendiente - coalesce(r.reserved, 0) - coalesce(r.paid, 0)) AS available_amount'),
          trx.raw('coalesce(s.is_critical, false) AS is_critical'), trx.raw('s.critical_reason'),
          // ⛔ `authorized_by` NULL y es correcto: a esta factura nadie la aceptó en una bandeja.
          // La autorización es LIBERAR EL DÍA, no un acto por documento (ADR-094 §2).
          trx.raw('NULL::text AS authorized_by'), trx.raw('NULL::timestamptz AS authorized_at'),
          trx.raw(`'pending'::text AS status`), trx.raw('NULL::text AS notes'),
          trx.raw('v.fecha::timestamptz AS created_at'), trx.raw('v.sucursal AS branch_code'),
          trx.raw('s.id AS payee_id'),
          trx.raw(sqlVentanaProntoPago('v', 'd')),
          // [TP.20.5] La ficha de la factura: la arma el backend porque es el unico que sabe
          // las cuatro partes de la clave natural (sucursal, tipo, subtipo, folio).
          trx.raw(`'oblig:' || v.sucursal || '|' || v.doc_tipo || '|' || v.doc_sub
                             || '|' || btrim(v.folio) AS entity_ref`),
          // [PGP.12] La referencia del proveedor (`kdxe.c16`, publicada por la vista en la
          // migración 20261026122438) y el código del acreedor. Esta es la pata que importa:
          // trae el 98.7 % de la deuda y era la única sin referencia.
          trx.raw(`v.referencia AS doc_ref`), trx.raw('v.proveedor AS payee_code'),
        );

      const unionSql = `(${legBudget.toQuery()} UNION ALL ${legCommitment.toQuery()} UNION ALL ${legSupplier.toQuery()} UNION ALL ${legKepler.toQuery()}) AS ob`;
      const base = trx.select(cols.map((c) => `ob.${c}`)).from(trx.raw(unionSql));
      if (q.source) base.where('ob.obligation_source', q.source);
      if (q.classification) base.where('ob.classification', q.classification);
      if (q.onlyCritical) base.where('ob.is_critical', true);
      // [TP.20.4] El filtro que faltaba para armar el dia mirando lo que caduca.
      if (q.prontoPago) base.where('ob.pronto_estado', q.prontoPago);
      /**
       * `[PGP.12]` **Qué alcanza el buscador.** Era `beneficiary` + `concept`, y `concept` para la
       * deuda de Kepler es el folio interno pelado — así que por folio **sí** se podía buscar, pero
       * por la referencia del proveedor (`0-F-2525`) y por el código del acreedor (`CNFR001`) no.
       *
       * ⛔ Y el folio solo **no identifica**: medido el 2026-10-26 sobre los 2,897 documentos que
       * la pantalla muestra, **769 (26.5 %) comparten folio con otro**, hasta 5 documentos con el
       * mismo número. Buscar `0000304` devuelve el de $8,000,000 de ACREEDOR ARTURO LOPEZ OROZCO
       * **y** uno de $45,343.77 de MEGA ALIMENTOS en Morelia Abastos. Por eso la referencia no es
       * un adorno: en 92.6 % de los casos es lo que desempata.
       */
      if (q.search?.trim()) {
        const s = q.search.trim();
        // `[PGP.12]` El tipo sale del USO: a `w` se le encadenan `whereILike`/`orWhereILike`,
        // o sea que es el constructor de consultas de Knex, no un `any`. Mismo patrón que
        // `commission-padron.service.ts`.
        base.andWhere((w: Knex.QueryBuilder) => w
          .whereILike('ob.beneficiary', `%${s}%`)
          .orWhereILike('ob.concept', `%${s}%`)
          .orWhereILike('ob.doc_ref', `%${s}%`)
          .orWhereILike('ob.payee_code', `%${s}%`));
      }
      if (q.dueFrom) base.where('ob.original_due_date', '>=', q.dueFrom);
      if (q.dueTo) base.where('ob.original_due_date', '<=', q.dueTo);
      if (q.onlyAvailable !== false) base.where('ob.available_amount', '>', 0).whereIn('ob.status', ['pending', 'partial']);
      /**
       * `[TP.17.2]` **El techo se DECLARA, no se calla** (ADR-056).
       *
       * Acá había un `.limit(1000)` sin más. Con 37 obligaciones capturadas era invisible; con la
       * deuda derivada son **2,895**, y medido el 2026-10-16 el corte dejaba fuera **1,895
       * documentos por $105,683,725** — el **79 % del dinero**. Y no es un recorte neutro: el
       * orden es por vencimiento ascendente, así que lo que se oculta es **lo más reciente**
       * (el corte caía en 2026-06-04). La pantalla se habría visto impecable mostrando mil
       * facturas viejas, que es justo lo contrario de lo que este origen viene a resolver.
       *
       * Por eso la respuesta ahora lleva `total`: quien la pinta puede decir «mostrando N de M».
       * ⚠️ Esto **no es paginación** — es un techo honesto. La paginación real queda como deuda
       * con nombre en el tracker; mientras tanto el filtro y la búsqueda son el camino para
       * llegar a cualquier factura.
       */
      const [{ total }] = await base.clone().clearSelect().clearOrder()
        .count<{ total: string }[]>({ total: '*' });
      /*
       * `[PGP.7]` Dos ordenes, uno por pregunta. ⛔ `NULLS LAST` en los dos campos del descuento:
       * una factura sin ventana medible NO es urgente, es desconocida, y ponerla arriba mandaria
       * a Tesoreria a mirar primero lo que nadie midio.
       */
      const orderBy = q.orden === 'descuento'
        ? 'ob.pronto_fecha_limite ASC NULLS LAST, ob.pronto_beneficio DESC NULLS LAST'
        : 'ob.original_due_date ASC NULLS LAST, ob.available_amount DESC';
      const rows = await base.orderByRaw(orderBy).limit(limit).offset(offset);
      return { rows, total: Number(total), limit, offset };
    });
  }

  /**
   * `[PGP.9]` **Lo que de verdad salió cada día, del ERP — ya no del Excel de Tesorería.**
   *
   * ── Por qué cambió la fuente ────────────────────────────────────────────────────────────
   * Pedido de Edgar el 2026-10-24: *«no debemos depender de que se esté cargando un libro»*.
   * Tenía razón, y la medición es contundente. Las dos fuentes, el mismo día:
   *
   *     libro de Tesorería (Excel)    último pago 2026-08-28 · última carga 2026-08-08 · 77 días
   *     ERP (erp_supplier_payments)   último pago 2026-12-01 · recalculado HOY      ·  0 días
   *
   * Y no es sólo que se haya detenido: **cuando estaba vivo ya cubría un tercio**. Agosto, mes
   * a mes: el libro registró **157 pagos / $17.9 M** contra **530 / $45.2 M** del ERP. En
   * septiembre y octubre el libro tiene **cero**, el ERP tiene 346 y 179.
   *
   * ⇒ Un testigo que alguien carga a mano no es un testigo: es una tarea que se olvida, y
   * mientras se olvida la pantalla publica «libro sin cargar» en todos los días. El ERP es el
   * mismo hecho —qué dinero salió ese día— y llega solo.
   *
   * ── Lo que se conserva de `[TP.21.1]` ───────────────────────────────────────────────────
   * ⛔ **Sigue sin casar renglones.** Se suma por fecha de pago, que es la llave que las dos
   * líneas comparten de verdad, y se publica como **otro universo**: el calendario dice lo que
   * se va a pagar, esto dice lo que el ERP registra que salió. Casarlos fila por fila es lo de
   * `[PP.4]` ($273 M indefendibles).
   *
   * ⭐ **Y la lección de ADR-056 se conserva cambiando de eje.** Antes un día sin filas podía
   * ser «el Excel no tiene ese mes»; ahora puede ser «el espejo del ERP no se ha recalculado».
   * Por eso en vez de `mes_cargado` viaja `data_as_of`: con el espejo fresco, un cero significa
   * **no se pagó** (un sábado, por ejemplo); con el espejo viejo, significa **no sabemos**. El
   * cero sin su fecha al lado es el mismo cero dibujado de siempre.
   */
  private async weekBook(from: string, to: string): Promise<Record<string, { monto: number; n: number; data_as_of: string | null }>> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const porDia = await trx('analytics.erp_supplier_payments')
        .select(trx.raw(`to_char(pago_date,'YYYY-MM-DD') AS dia`))
        .sum({ monto: 'monto' }).count({ n: '*' })
        .max({ as_of: 'computed_at' })
        .where({ tenant_id: tenantId })
        .whereBetween('pago_date', [from, to])
        .groupByRaw('1');

      /*
       * La frescura del ESPEJO, no la del día: un día sin pagos no tiene `computed_at` propio y
       * aun así hace falta saber si el espejo está al día para leer ese cero. Se pregunta aparte,
       * sobre la ventana reciente, que es lo que indica si el feed sigue llegando.
       */
      const [fresco] = await trx('analytics.erp_supplier_payments')
        .max({ as_of: 'computed_at' })
        .where({ tenant_id: tenantId });
      const asOf = (fresco as { as_of: Date | string | null })?.as_of;
      const asOfIso = asOf ? new Date(asOf).toISOString() : null;

      const out: Record<string, { monto: number; n: number; data_as_of: string | null }> = {};
      for (const d of weekDates(from)) {
        const fila = (porDia as { dia: string; monto: string | null; n: string }[]).find((x) => x.dia === d);
        out[d] = { monto: Number(fila?.monto ?? 0), n: Number(fila?.n ?? 0), data_as_of: asOfIso };
      }
      return out;
    });
  }

  // ── Resumen del día (capacidad + asignado + restante + ejecutado + pendiente) ────────
  async daySummary(date: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const capacity = await trx('budget.daily_capacity').where({ tenant_id: tenantId, capacity_date: date }).first();
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
      let assigned = 0, executed = 0;
      if (lot) {
        const rows = await trx('finance.payment_allocations').where({ lot_id: lot.id }).whereIn('status', ['pending', 'executed'])
          .select('status').sum({ monto: 'amount_assigned' }).groupBy('status');
        for (const r of rows as any[]) {
          const m = Number(r.monto);
          assigned += m;
          if (r.status === 'executed') executed += m;
        }
      }
      const authorized = capacity ? Number(capacity.authorized_amount) : null;
      return {
        date,
        capacity_defined: !!capacity,
        authorized_amount: authorized,
        assigned_amount: assigned,
        remaining_amount: authorized == null ? null : authorized - assigned,
        executed_amount: executed,
        pending_execution_amount: assigned - executed,
        exceeded: authorized != null && assigned > authorized,
        lot_status: lot?.status ?? null,
      };
    });
  }

  // ── Pagos del día (con sus documentos resueltos a beneficiario/concepto) ─────────────
  async listDayAllocations(date: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
      if (!lot) return [];
      const allocations = await trx('finance.payment_allocations').where({ lot_id: lot.id }).whereNot('status', 'cancelled')
        .orderByRaw('priority_rank ASC NULLS LAST').orderBy('created_at', 'asc');
      if (!allocations.length) return [];
      const items = await trx('finance.payment_allocation_items').whereIn('allocation_id', allocations.map((a: any) => a.id));
      const bySource: Record<string, string[]> = {};
      for (const it of items as any[]) (bySource[it.obligation_source] ??= []).push(it.obligation_id);
      const labels = new Map<string, { beneficiary: string; concept: string; supplier_id?: string; branch_code?: string | null }>();
      for (const source of Object.keys(bySource) as ObligationSource[]) {
        const ids = bySource[source];
        if (source === 'supplier_payable') {
          const rows = await trx('commercial.supplier_payment_obligations as o')
            .join('catalog.suppliers as s', 's.id', 'o.supplier_id')
            .whereIn('o.id', ids)
            .select('o.id', 's.name as beneficiary', 'o.supplier_id', trx.raw("nullif(btrim(o.kepler_sucursal), '') as branch_code"), trx.raw("coalesce(o.concept, o.invoice_folio, 'Mercancía') as concept"));
          for (const r of rows as { id: string; beneficiary: string; concept: string; supplier_id: string; branch_code: string | null }[]) labels.set(`${source}:${r.id}`, { beneficiary: r.beneficiary, concept: r.concept, supplier_id: r.supplier_id, branch_code: r.branch_code ?? null });
        } else if (source === 'kepler_payable') {
          // `[TP.18]` El derivado no tiene tabla: su etiqueta se rearma desde la vista por la
          // misma llave determinística con que se guardó el item (ADR-094 §4).
          const rows = await trx('analytics.v_supplier_payables as v')
            .leftJoin('catalog.suppliers as s', 's.code', 'v.proveedor')
            .whereRaw(`${KEPLER_PAYABLE_ID} = ANY(?::uuid[])`, [ids])
            .select(
              trx.raw(`${KEPLER_PAYABLE_ID} AS id`),
              trx.raw(`coalesce(s.name, v.proveedor_nombre, v.proveedor) AS beneficiary`),
              trx.raw(`coalesce(nullif(btrim(v.folio), ''), 'Factura') AS concept`),
              's.id AS supplier_id', 'v.sucursal AS branch_code',
            );
          for (const r of rows as { id: string; beneficiary: string; concept: string; supplier_id: string | null; branch_code: string | null }[]) {
            labels.set(`${source}:${r.id}`, { beneficiary: r.beneficiary, concept: r.concept, supplier_id: r.supplier_id ?? undefined, branch_code: r.branch_code ?? null });
          }
        } else {
          const rows = await trx(TABLE_BY_SOURCE[source] as string).whereIn('id', ids).select('id', 'beneficiary', 'concept');
          for (const r of rows as any[]) labels.set(`${source}:${r.id}`, { beneficiary: r.beneficiary, concept: r.concept ?? '—' });
        }
      }
      const itemsByAllocation = new Map<string, any[]>();
      for (const it of items as any[]) {
        const label = labels.get(`${it.obligation_source}:${it.obligation_id}`);
        const arr = itemsByAllocation.get(it.allocation_id) ?? [];
        arr.push({ ...it, beneficiary: label?.beneficiary ?? '—', concept: label?.concept ?? '—', supplier_id: label?.supplier_id ?? null, branch_code: label?.branch_code ?? null });
        itemsByAllocation.set(it.allocation_id, arr);
      }
      // `[TP.16]` Alias de la cuenta de ORIGEN, para que «Ordenar y pagar» diga de dónde sale el dinero.
      const originIds = [...new Set(allocations.map((a: AllocationRowLite) => a.bank_account_id).filter(Boolean))] as string[];
      const origin = new Map<string, string>();
      // `[PGP.33]` Y su CLASE, porque de ella depende QUIÉN ejecuta: una cuenta de banco la
      // dispersa Tesorería; la caja, Caja General. El documento impreso le hablaba a Caja General
      // para los $404,105,108 (87.3 %) que salen de banco y nunca pasan por ahí.
      const originKind = new Map<string, string>();
      if (originIds.length) {
        const accs = await trx('finance.bank_accounts').whereIn('id', originIds).select('id', 'alias', 'bank', 'account_label', 'kind');
        for (const r of accs as { id: string; alias: string | null; bank: string; account_label: string; kind: string | null }[]) {
          origin.set(r.id, r.alias || `${r.bank} ${r.account_label}`);
          originKind.set(r.id, r.kind || 'bank');
        }
      }
      return allocations.map((a: AllocationRowLite) => ({
        ...a, amount_assigned: Number(a.amount_assigned),
        bank_account_label: a.bank_account_id ? origin.get(a.bank_account_id) ?? null : null,
        bank_account_kind: a.bank_account_id ? originKind.get(a.bank_account_id) ?? null : null,
        items: (itemsByAllocation.get(a.id) ?? []).map((it) => ({ ...it, applied_amount: Number(it.applied_amount) })),
      }));
    });
  }

  /**
   * `[TP.16]` La semana completa (lunes a domingo) que contiene `date`: por día, su resumen, sus
   * pagos y el folio del lote. Compone los mismos resolvedores del día (`daySummary`,
   * `listDayAllocations`) en vez de re-implementarlos: un número del día y el de la semana no
   * pueden diferir.
   */
  async weekView(date: string): Promise<PaymentCalendarWeek> {
    this.assertDate(date);
    // `2026-02-30` pasa el regex y JS lo «corrige» a marzo: una fecha imposible se rechaza.
    const t = Date.parse(date + 'T00:00:00Z');
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) throw new BadRequestException('Fecha inválida (YYYY-MM-DD)');
    const days = weekDates(date);
    // En serie a propósito: 7 días × 3 lecturas en paralelo serían 21 transacciones a la vez
    // contra el pool de prod, por una pantalla.
    const out: PaymentCalendarWeek['days'] = [];
    for (const d of days) {
      const summary = await this.daySummary(d);
      const allocations = (await this.listDayAllocations(d)) as PaymentCalendarAllocation[];
      const lot = await this.getLot(d);
      out.push({ date: d, summary, allocations, lot_folio: (lot?.folio as string | undefined) ?? null });
    }
    // `[TP.21.1]` El pasado de esta misma semana, según el libro de Tesorería. UNA consulta para
    // los siete días, no una por día: la nota de arriba ya cuenta 21 transacciones en serie y
    // sumar siete más por una tira de encabezado sería pagar el doble por la mitad del dato.
    const libro = await this.weekBook(days[0], days[6]);
    for (const day of out) day.libro = libro[day.date] ?? null;
    return { from: days[0], to: days[6], days: out };
  }

  /**
   * `[PGP.33]` Cuentas de ORIGEN elegibles: **todas las activas, incluida la caja.**
   *
   * ⛔⛔ Hasta hoy excluía `kind = 'cash'` con la premisa escrita *«la caja no es origen de una
   * transferencia»*. **El ERP la contradice.** Medido contra prod el 2026-10-29 sobre
   * `analytics.erp_supplier_payments` cruzado con `analytics.kepler_bank_movements`:
   *
   *   - **2,771 pagos a proveedor, $54,897,784**, salieron de una cuenta que el propio decode de
   *     Kepler clasifica `tipo_cuenta = 'caja'`, CAJA GENERAL — y nuestro catálogo tiene
   *     exactamente una cuenta `kind = 'cash'`, que es ésa;
   *   - son el **56.7 % de los 4,898 pagos** por conteo (el 12.7 % del dinero: son los chicos).
   *
   * O sea que la premisa no describía a Tesorería, la contradecía: el desplegable **no podía
   * reproducir más de la mitad de cómo se ha pagado siempre**, y quien pagaba desde Caja General
   * tenía que mentirle al formulario eligiendo otra cuenta. Se retira el filtro.
   *
   * ⚠️ **Lo que NO se afirma** (ADR-056): si esos 2,771 salieron físicamente en efectivo o por una
   * transferencia ordenada desde el escritorio de Caja General **no se puede saber desde acá** —
   * Kepler los rotula `transferencia` porque su `kdm1.c31` sólo distingue tres valores y
   * `efectivo` no es uno. Por eso la caja se OFRECE y no se propone sola.
   */
  async originAccounts(): Promise<PaymentOriginAccount[]> {
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => trx('finance.bank_accounts')
      .where('active', true)
      .select('id', 'bank', 'account_label', 'alias', 'kind')
      .orderBy([{ column: 'bank' }, { column: 'account_label' }]));
  }

  /**
   * `[PGP.30]` **Con qué se le suele pagar a cada acreedor**, para precargar método y cuenta.
   *
   * ⚠️ Se sirve **entera y de una vez** (316 filas, 292 ms medidos contra prod) en lugar de una
   * consulta por pago: el día más cargado de la semana trae 16 pagos, y 16 viajes para precargar
   * un desplegable cuesta más que la tabla completa.
   *
   * ⛔ La llave que sale es `supplier_id`, no el código de Kepler: es la que el Calendario ya
   * trae en cada renglón. Medido: los 316 acreedores con hábito resuelven a un `catalog.suppliers`
   * — **no se pierde ninguno** en la traducción.
   */
  async paymentHabits(): Promise<SupplierPaymentHabit[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    const { rows } = await this.tk.run((trx) => trx.raw(
      `SELECT s.id                                   AS supplier_id,
              h.proveedor_code,
              h.metodo_estado, h.metodo_sugerido,
              h.metodo_veces, h.metodo_de,
              to_char(h.metodo_ultima_vez, 'YYYY-MM-DD') AS metodo_ultima_vez,
              h.cuenta_estado, h.cuenta_origen_id, h.cuenta_origen_nombre,
              h.cuenta_veces, h.cuenta_de
         FROM analytics.v_supplier_payment_habit h
         JOIN catalog.suppliers s
           ON btrim(s.code) = btrim(h.proveedor_code) AND s.tenant_id = ?
        WHERE h.metodo_sugerido IS NOT NULL
           OR h.cuenta_origen_id IS NOT NULL
           OR h.cuenta_estado = 'caja_general'`, [tenantId]));
    return rows as SupplierPaymentHabit[];
  }

  /** El lote del día tal cual (folio/status/released_by/at) — usado por el documento imprimible. */
  async getLot(date: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first());
  }

  // ── Crear un pago (fecha + monto; SIN método/banco — criterio #4) ────────────────────
  async createAllocation(dto: CreateAllocationDto, username: string) {
    this.assertDate(dto.date);
    if (!dto.items?.length) throw new BadRequestException('Se requiere al menos una obligación');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const classifications = new Set<string>();
      const payees = new Set<string>();
      const branches = new Set<string>();
      for (const it of dto.items) {
        if (!(Number(it.applied_amount) > 0)) throw new BadRequestException('applied_amount debe ser > 0');
        if (!(it.obligation_source in CLASSIFICATION_BY_SOURCE)) throw new BadRequestException('obligation_source inválido');
        const row = await this.loadObligationRow(trx, tenantId, it.obligation_source, it.obligation_id);
        // `[TP.18]` Para el origen derivado, "no encontrada" también significa **Kepler ya no la
        // debe** (la vista sólo trae saldo > 0): no se programa, que es el mismo veredicto.
        if (!row) throw new NotFoundException(`Obligación ${it.obligation_id} no encontrada`);
        if (row.status === 'cancelled') throw new BadRequestException('La obligación está cancelada');
        const available = Number(row.original_amount) - Number(row.reserved_amount) - Number(row.paid_amount);
        if (Number(it.applied_amount) > available + 0.005) throw new BadRequestException(`Excede el saldo disponible de la obligación (disponible: ${available.toFixed(2)})`);
        await this.assertKeplerBalance(trx, it.obligation_source, row, Number(it.applied_amount));
        classifications.add(classificationOf(it.obligation_source, row));
        const k = paymentGroupKey(it.obligation_source, row);
        payees.add(k.payee);
        branches.add(k.branch);
      }
      if (classifications.size > 1) throw new BadRequestException('Un mismo pago no puede mezclar clasificaciones distintas (compromiso financiero / gasto / proveedor) — crea pagos separados.');
      if (payees.size > 1) throw new BadRequestException('Un mismo pago no puede juntar facturas de beneficiarios distintos: es una sola transferencia a una sola cuenta. Crea un pago por beneficiario.');
      if (branches.size > 1) throw new BadRequestException(`Un mismo pago no puede juntar facturas de sucursales distintas (${[...branches].join(', ')}): cada pago entra al centro de costo de su almacén. Crea un pago por sucursal.`);
      const lot = await this.getOrCreateLot(trx, tenantId, dto.date);
      if (LOCKED_LOT_STATUSES.has(lot.status)) throw new BadRequestException('El día ya fue autorizado/cerrado — no admite pagos nuevos (reprograma a otro día).');
      const amountAssigned = dto.items.reduce((s, it) => s + Number(it.applied_amount), 0);
      const [allocation] = await trx('finance.payment_allocations').insert({
        tenant_id: tenantId, lot_id: lot.id, classification: [...classifications][0],
        priority_rank: dto.priority_rank ?? null, amount_assigned: amountAssigned,
        notes: dto.notes ?? null, created_by: username,
      }).returning('*');
      for (const it of dto.items) {
        await trx('finance.payment_allocation_items').insert({
          tenant_id: tenantId, allocation_id: allocation.id, obligation_source: it.obligation_source,
          obligation_id: it.obligation_id, applied_amount: it.applied_amount,
        });
        await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      }
      return allocation;
    });
  }

  async addItem(allocationId: string, item: AllocationItemDto, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se puede modificar un pago pendiente');
      // `[TP.16.4]` Sumar facturas a un pago de un día ya AUTORIZADO cambiaría lo que Gerencia firmó.
      // `createAllocation` ya lo impedía para pagos nuevos; aquí faltaba.
      const itemLot = await trx('finance.payment_calendar_lots').where({ id: allocation.lot_id }).first();
      if (itemLot && LOCKED_LOT_STATUSES.has(itemLot.status)) throw new BadRequestException('El día ya fue autorizado: no se le pueden sumar facturas a sus pagos (agrégalas a otro día).');
      const row = await this.loadObligationRow(trx, tenantId, item.obligation_source, item.obligation_id);
      if (!row) throw new NotFoundException('Obligación no encontrada');
      // `[TP.17.1b]` Va DESPUÉS de cargar la fila, y no antes como hasta ahora: la clasificación
      // del origen derivado vive en la fila (un crédito bancario no es una factura de mercancía),
      // así que no se puede decidir con sólo mirar el `obligation_source`.
      if (classificationOf(item.obligation_source, row) !== allocation.classification) throw new BadRequestException('La obligación no coincide con la clasificación de este pago');
      const available = Number(row.original_amount) - Number(row.reserved_amount) - Number(row.paid_amount);
      if (Number(item.applied_amount) > available + 0.005) throw new BadRequestException(`Excede el saldo disponible de la obligación (disponible: ${available.toFixed(2)})`);
      await this.assertKeplerBalance(trx, item.obligation_source, row, Number(item.applied_amount));
      // `[TP.16.3]` Lo que se agrega a un pago existente tiene el mismo beneficiario y sucursal que lo que ya trae.
      const [first] = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId }).whereNot({ obligation_id: item.obligation_id }).orderBy('created_at', 'asc').limit(1);
      if (first) {
        const firstRow = await this.loadObligationRow(trx, tenantId, first.obligation_source as ObligationSource, first.obligation_id);
        const a = paymentGroupKey(first.obligation_source, firstRow ?? {}), b = paymentGroupKey(item.obligation_source, row);
        if (a.payee !== b.payee) throw new BadRequestException('Esta factura es de otro beneficiario: un pago es una sola transferencia a una sola cuenta.');
        if (a.branch !== b.branch) throw new BadRequestException(`Esta factura es de la sucursal ${b.branch} y el pago es de la ${a.branch}: cada pago entra al centro de costo de su almacén.`);
      }
      await trx('finance.payment_allocation_items').insert({
        tenant_id: tenantId, allocation_id: allocationId, obligation_source: item.obligation_source,
        obligation_id: item.obligation_id, applied_amount: item.applied_amount,
      });
      await this.recalcObligation(trx, item.obligation_source, item.obligation_id);
      await this.recalcAllocationTotal(trx, allocationId);
      void username;
      return trx('finance.payment_allocations').where({ id: allocationId }).first();
    });
  }

  async removeItem(allocationId: string, itemId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const item = await trx('finance.payment_allocation_items').where({ tenant_id: tenantId, id: itemId, allocation_id: allocationId }).first();
      if (!item) throw new NotFoundException('Documento no encontrado en este pago');
      const allocation = await trx('finance.payment_allocations').where({ id: allocationId }).first();
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se puede modificar un pago pendiente');
      const [{ count }] = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId }).whereNot('id', itemId).count();
      if (Number(count) === 0) throw new BadRequestException('Un pago debe tener al menos un documento — cancela el pago en vez de vaciarlo');
      await trx('finance.payment_allocation_items').where({ id: itemId }).del();
      await this.recalcObligation(trx, item.obligation_source, item.obligation_id);
      await this.recalcAllocationTotal(trx, allocationId);
      return { ok: true };
    });
  }

  /**
   * Reprograma: cancela el pago actual (libera el día viejo) y crea uno nuevo en la fecha nueva.
   * TP.10 — exige motivo (cerrado + 'otro' con detalle libre): permite reprogramar un pago
   * PENDIENTE (ej. presupuesto recortado) o uno FALLIDO (cuenta errónea/banco/devuelto/otro).
   */
  async reprogram(allocationId: string, newDate: string, reason: ReprogramReason, reasonDetail: string | undefined, username: string) {
    this.assertDate(newDate);
    if (!REPROGRAM_REASONS.includes(reason)) throw new BadRequestException(`reason inválido — debe ser uno de: ${REPROGRAM_REASONS.join(', ')}`);
    if (reason === 'otro' && !reasonDetail?.trim()) throw new BadRequestException('reasonDetail es requerido cuando reason = "otro"');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (!['pending', 'failed'].includes(allocation.status)) throw new BadRequestException('Solo se puede reprogramar un pago pendiente o fallido');
      const items = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId });
      await trx('finance.payment_allocations').where({ id: allocationId }).update({
        status: 'cancelled', notes: `${allocation.notes ?? ''}\n[reprogramado a ${newDate}]`.trim(),
        reprogram_reason: reason, reprogram_reason_detail: reason === 'otro' ? reasonDetail!.trim() : null,
        updated_by: username, updated_at: trx.fn.now(),
      });
      const lot = await this.getOrCreateLot(trx, tenantId, newDate);
      if (LOCKED_LOT_STATUSES.has(lot.status)) throw new BadRequestException('El día destino ya fue autorizado/cerrado');
      const [newAllocation] = await trx('finance.payment_allocations').insert({
        tenant_id: tenantId, lot_id: lot.id, classification: allocation.classification,
        priority_rank: null, amount_assigned: allocation.amount_assigned,
        notes: allocation.notes, payment_method: allocation.payment_method,
        bank_account_id: allocation.bank_account_id, destination_account_text: allocation.destination_account_text,
        cash_register_text: allocation.cash_register_text, reference_text: allocation.reference_text,
        supplier_payment_account_id: allocation.supplier_payment_account_id,
        reprogrammed_from_id: allocation.id, created_by: username,
      }).returning('*');
      for (const it of items as any[]) {
        await trx('finance.payment_allocation_items').insert({
          tenant_id: tenantId, allocation_id: newAllocation.id, obligation_source: it.obligation_source,
          obligation_id: it.obligation_id, applied_amount: it.applied_amount, agreement_id: it.agreement_id,
        });
        await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      }
      return newAllocation;
    });
  }

  /**
   * Completa el método de pago. `supplier_payment_account_id` (TP.7) referencia el catálogo de
   * cuentas del proveedor en vez de texto libre — evita el error de captura que pidió el usuario;
   * `destination_account_text` se autocompleta como snapshot legible (banco+CLABE) para el
   * documento impreso, pero SIEMPRE puede capturarse a mano para compromisos/gastos sin proveedor.
   */
  async prepare(allocationId: string, dto: PrepareAllocationDto, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!['transferencia', 'cheque', 'efectivo', 'cargo_automatico'].includes(dto.payment_method)) throw new BadRequestException('payment_method inválido');
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se prepara un pago pendiente');

      // `[TP.16]` La cuenta DESTINO sólo existe para transferencia / cargo automático. En efectivo o
      // cheque se descarta: si no, la favorita del proveedor (o un texto de una preparación anterior)
      // terminaba impresa como destino en la instrucción a Caja General.
      const usesDestination = dto.payment_method === 'transferencia' || dto.payment_method === 'cargo_automatico';
      let destinationText = usesDestination ? dto.destination_account_text ?? null : null;
      const accountId = usesDestination ? dto.supplier_payment_account_id ?? null : null;
      if (accountId) {
        const acc = await trx('commercial.supplier_payment_accounts').where({ tenant_id: tenantId, id: accountId, status: 'activa' }).first();
        if (!acc) throw new BadRequestException('La cuenta de pago seleccionada no existe o está inactiva');
        destinationText = `${acc.bank_name}${acc.clabe ? ' · CLABE ' + acc.clabe : ''}${acc.account_number ? ' · Cta ' + acc.account_number : ''}${acc.alias ? ' (' + acc.alias + ')' : ''}`;
      }
      // `[TP.16]` ORIGEN (nuestra cuenta) y DESTINO (la del beneficiario) son dos datos distintos, y
      // el layout del banco pide los dos. Antes bastaba uno cualquiera: una transferencia quedaba
      // «preparada» con sólo la cuenta de origen y sin saber a dónde iba el dinero.
      const needsOrigin = dto.payment_method === 'transferencia' || dto.payment_method === 'cargo_automatico' || dto.payment_method === 'cheque';
      if (needsOrigin) {
        if (!dto.bank_account_id) throw new BadRequestException('Elige la cuenta de origen (de cuál cuenta nuestra sale el pago).');
        // `[PGP.33]` La caja YA es un origen válido: medido, 2,771 pagos ($54,897,784) salieron de
        // CAJA GENERAL. Antes este `where` la rechazaba y el error culpaba a la cuenta.
        const origin = await trx('finance.bank_accounts').where({ id: dto.bank_account_id, active: true }).first();
        if (!origin) throw new BadRequestException('La cuenta de origen no existe o está inactiva.');
      }
      if (dto.payment_method === 'transferencia' && !destinationText?.trim()) {
        throw new BadRequestException('Transferencia requiere la cuenta destino (elige una del catálogo del proveedor o captura la CLABE).');
      }
      // Una CLABE capturada a mano se valida con su dígito de control: el error de dedo se ve aquí,
      // no cuando el banco rechaza el layout.
      // Sólo corridas de dígitos CONTIGUOS: pegar grupos separados por espacio inventaba una CLABE.
      // 18 → se valida el control; 17 o 19 → casi seguro una CLABE con un dígito de más/menos.
      if (!accountId) {
        for (const run of (destinationText ?? '').match(/\d+/g) ?? []) {
          if (run.length === 17 || run.length === 19) throw new BadRequestException(`«${run}» tiene ${run.length} dígitos: una CLABE lleva 18. Revísala.`);
          if (run.length === 18 && !clabeValida(run)) throw new BadRequestException(`La CLABE ${run} no es válida (el dígito de control no cuadra). Revísala.`);
        }
      }
      if (dto.payment_method === 'cheque' && !dto.reference_text?.trim()) throw new BadRequestException('Cheque requiere folio/referencia');
      if (dto.payment_method === 'efectivo' && !dto.cash_register_text?.trim()) throw new BadRequestException('Efectivo requiere la caja de salida');

      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId }).update({
        payment_method: dto.payment_method, bank_account_id: needsOrigin ? dto.bank_account_id : null,
        destination_account_text: destinationText, cash_register_text: dto.cash_register_text ?? null,
        reference_text: dto.reference_text ?? null, supplier_payment_account_id: accountId,
        updated_by: username, updated_at: trx.fn.now(),
      }).returning('*');
      return updated;
    });
  }

  /**
   * `[TP.19.4]` **Propone el documento de Kepler de un pago ejecutado — no lo adivina** (O3).
   *
   * Teclear la terna `(sucursal, doc_prefix, folio)` es exactamente el trabajo que esta liga venía
   * a evitar. El espejo del ERP ya tiene con qué reconocerla: **monto, día y proveedor**.
   *
   * ⛔ **Liga sola SÓLO si hay un único candidato**, y es el mismo criterio con el que `[PC.6]`
   * auto-valida un comprobante: cuando el cruce no deja lugar a duda. Con dos candidatos
   * **devuelve los dos y no elige** — elegir por el usuario entre dos pagos del mismo proveedor y
   * monto es justo donde una trazabilidad inventada se vuelve indistinguible de una real.
   *
   * ⚠️ Tolerancias, dichas: **± 1 centavo** en el monto (redondeo) y **± 3 días** entre el día del
   * lote y la fecha del documento, porque el ERP se captura después de que sale el dinero.
   */
  async sugerirKeplerPayment(allocationId: string): Promise<SugerenciaKepler> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const a = await trx('finance.payment_allocations as pa')
        .join('finance.payment_calendar_lots as pl', 'pl.id', 'pa.lot_id')
        .where({ 'pa.tenant_id': tenantId, 'pa.id': allocationId })
        .select('pa.*', 'pl.lot_date').first();
      if (!a) throw new NotFoundException('Pago no encontrado');
      if (a.status !== 'executed') throw new BadRequestException('Sólo se busca el documento de un pago ya ejecutado.');
      if (a.kepler_payment_folio) return { ya_ligado: true, folio: a.kepler_payment_folio, candidatos: [] };

      // Los códigos de proveedor que cubre este pago (las dos clases de factura los tienen).
      const codigos: string[] = (await trx.raw(`
        SELECT DISTINCT cod FROM (
          SELECT s.code AS cod
            FROM finance.payment_allocation_items i
            JOIN commercial.supplier_payment_obligations o ON o.id = i.obligation_id
            JOIN catalog.suppliers s ON s.id = o.supplier_id
           WHERE i.allocation_id = :id AND i.obligation_source = 'supplier_payable'
          UNION
          SELECT v.proveedor AS cod
            FROM finance.payment_allocation_items i
            JOIN analytics.v_supplier_payables v ON ${KEPLER_PAYABLE_ID} = i.obligation_id
           WHERE i.allocation_id = :id AND i.obligation_source = 'kepler_payable'
        ) q WHERE cod IS NOT NULL`, { id: allocationId })).rows.map((r: { cod: string }) => String(r.cod).trim());

      if (!codigos.length) return { ya_ligado: false, candidatos: [], motivo: 'Este pago no cubre facturas de proveedor: no hay documento de Kepler que buscarle.' };

      const candidatos = await trx('analytics.erp_supplier_payments as p')
        .where('p.tenant_id', tenantId)
        // [TP.19.4.1] knex ACEPTA un Raw como columna de whereIn en tiempo de ejecucion, pero
        //   sus tipos no lo declaran (TS2769: Raw no es readonly string[]). La conversion dice
        //   eso y nada mas: no cambia la consulta. Aparecio al poner el tipo de retorno del
        //   metodo -- antes nadie obligaba a TypeScript a inferir esta linea.
        .whereIn(trx.raw('btrim(p.proveedor_code)') as unknown as string, codigos)
        .whereRaw('abs(p.monto::numeric - ?::numeric) <= 0.01', [a.amount_assigned])
        .whereRaw("p.pago_date BETWEEN ?::date - 3 AND ?::date + 3", [a.lot_date, a.lot_date])
        // Un documento que ya está ligado a otro pago no es candidato: el índice único lo
        // rechazaría igual, pero ofrecerlo y fallar después es la peor forma de decir que no.
        .whereNotExists(function () {
          this.select(trx.raw('1')).from('finance.payment_allocations as x')
            .whereRaw('x.kepler_payment_sucursal = p.sucursal AND x.kepler_payment_doc_prefix = p.doc_prefix')
            .whereRaw('x.kepler_payment_folio = p.folio');
        })
        .select('p.sucursal', 'p.doc_prefix', 'p.folio', 'p.pago_date', 'p.proveedor_code', 'p.proveedor_nombre',
                trx.raw('p.monto::numeric AS monto'))
        .orderBy('p.pago_date', 'asc').limit(10);

      return { ya_ligado: false, candidatos, unico: candidatos.length === 1 };
    });
  }

  /**
   * `[TP.19.3]` **Liga un pago del Calendario con su documento en Kepler** (O3).
   *
   * Va aparte de `execute()` porque el dinero sale **antes** de que el ERP capture el documento:
   * exigir la terna al ejecutar obligaría a inventar un folio para poder cerrar el pago. Acá se
   * liga cuando existe, y mientras tanto lo que falta se ve como falta (ADR-056).
   *
   * ⛔ Se verifica que el documento **exista** en el espejo del ERP y que el beneficiario coincida:
   * ligar a un folio tecleado mal es peor que no ligar — publicaría una trazabilidad falsa.
   */
  /**
   * ⚠️ `[TP.19.3.1]` Piso declarado: devuelve la fila actualizada de `payment_allocations`, y
   * sus columnas no se enumeran aca porque no se midieron. El unico consumidor (el controlador)
   * la pasa tal cual, asi que el piso alcanza y no finge una forma que nadie verifico.
   */
  async linkKeplerPayment(
    allocationId: string,
    ref: { sucursal: string; doc_prefix: string; folio: string },
    username: string,
  ) {
    const tenantId = this.tenantCtx.requireTenantId();
    const sucursal = String(ref?.sucursal ?? '').trim();
    const docPrefix = String(ref?.doc_prefix ?? '').trim();
    const folio = String(ref?.folio ?? '').trim();
    if (!sucursal || !docPrefix || !folio) throw new BadRequestException('Falta sucursal, tipo de documento o folio del pago en Kepler.');
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'executed') throw new BadRequestException('Sólo se liga un pago ya ejecutado: antes de que salga el dinero no hay documento que ligar.');
      const doc = await trx('analytics.erp_supplier_payments')
        .where({ tenant_id: tenantId, sucursal, doc_prefix: docPrefix, folio }).first();
      if (!doc) throw new NotFoundException(`Kepler no tiene el pago ${docPrefix} ${folio} de la sucursal ${sucursal}. Revisa el folio o espera a que el feed lo traiga.`);
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId })
        .update({
          kepler_payment_sucursal: sucursal, kepler_payment_doc_prefix: docPrefix, kepler_payment_folio: folio,
          kepler_payment_linked_at: trx.fn.now(), kepler_payment_linked_by: username,
          updated_by: username, updated_at: trx.fn.now(),
        }).returning('*');
      return updated;
    });
  }

  async execute(allocationId: string, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se ejecuta un pago pendiente');
      // `[PGP.33]` Decía «(Caja General lo necesita)». Medido: el 87.3 % del dinero ($404,105,108)
      // sale de una cuenta de BANCO, que ejecuta Tesorería. El mensaje ya no nombra a un área sola.
      if (!allocation.payment_method) throw new BadRequestException('Falta preparar el método de pago antes de ejecutar: quien dispersa necesita saber con qué se paga.');
      // `[TP.16]` Dos firmas: Caja General dispersa lo que Gerencia/Dirección AUTORIZÓ. Sin esto, un
      // pago se podía marcar pagado sin que nadie hubiera autorizado el día.
      const execLot = await trx('finance.payment_calendar_lots').where({ id: allocation.lot_id }).first();
      if (!execLot || !LOCKED_LOT_STATUSES.has(execLot.status)) {
        throw new BadRequestException('El día todavía no está autorizado: Gerencia o Dirección debe autorizarlo antes de marcar pagos como ejecutados.');
      }
      // `[TP.15]` Entre asignar y ejecutar pueden pasar días: si Kepler ya no debe la factura, no se paga.
      for (const it of (await trx('finance.payment_allocation_items').where({ allocation_id: allocationId })) as AllocationItemRow[]) {
        // `[TP.18]` Vale para los dos orígenes de factura. ⛔ Para el DERIVADO, además, que la
        // vista ya no traiga el documento significa que Kepler no lo debe: se trata igual que
        // saldo cero — no se ejecuta un pago contra una factura que el ERP ya no reconoce.
        if (it.obligation_source !== 'supplier_payable' && it.obligation_source !== 'kepler_payable') continue;
        const row = await this.loadObligationRow(trx, tenantId, it.obligation_source, it.obligation_id);
        if (row) await this.assertKeplerBalance(trx, it.obligation_source, row, Number(it.applied_amount), 0);
        else if (it.obligation_source === 'kepler_payable') {
          throw new BadRequestException('Kepler ya no tiene saldo pendiente de esta factura (¿se pagó por fuera o tiene nota de crédito?). No se programa ni se ejecuta.');
        }
      }
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId })
        .update({ status: 'executed', executed_at: trx.fn.now(), updated_by: username, updated_at: trx.fn.now() }).returning('*');
      const items = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId });
      // `[NX.11]` 2026-09-21 — nota para quien siga acá: era `items as any[]` y
      // `scripts/lint-boundary-gate.js` lo rechaza en líneas nuevas (ADR-052). Se nombran sólo los
      // 4 campos que este loop lee; el resto de la fila queda sin declarar a propósito, para no
      // inventar el esquema de `finance.payment_allocation_items` en un cast.
      for (const it of items as AllocationItemRow[]) {
        await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
        // §16.3 (default) — pagar = EJERCER + PAGAR la partida ligada (ADR-066, unificar el gasto).
        // Best-effort con SAVEPOINT: un pago YA en ejecución no se bloquea por una desincronía del
        // ledger, y el error NO envenena la trx del pago (gotcha 25P02). La deriva se registra.
        if (this.ledger && it.obligation_source === 'budget_expense') {
          const ob = await trx('budget.expense_obligations').where({ tenant_id: tenantId, id: it.obligation_id }).first();
          if (ob?.budget_line_id) {
            const applied = Number(it.applied_amount);
            await trx.raw('SAVEPOINT led_pay');
            try {
              await this.ledger.applyInTrx(trx, ob.budget_line_id, 'ejercido', applied, { sourceKind: 'payment', sourceRef: it.id }, username);
              await this.ledger.applyInTrx(trx, ob.budget_line_id, 'pago', applied, { sourceKind: 'payment', sourceRef: it.id }, username);
              await trx.raw('RELEASE SAVEPOINT led_pay');
            } catch (e) {
              await trx.raw('ROLLBACK TO SAVEPOINT led_pay').catch(() => undefined);
              this.logger.warn(`Ledger no movido para pago item ${it.id} (partida ${ob.budget_line_id}): ${(e as Error)?.message}`);
            }
          }
        }
      }
      return updated;
    });
  }

  async fail(allocationId: string, reason: string | undefined, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se marca como fallido un pago pendiente (uno ejecutado no se revierte acá)');
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId })
        .update({ status: 'failed', failure_reason: reason ?? null, updated_by: username, updated_at: trx.fn.now() }).returning('*');
      const items = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId });
      for (const it of items as any[]) await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      return updated;
    });
  }

  async cancelAllocation(allocationId: string, reason: string | undefined, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se puede cancelar un pago pendiente');
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId }).update({
        status: 'cancelled', notes: reason ? `${allocation.notes ?? ''}\n[cancelado] ${reason}`.trim() : allocation.notes,
        updated_by: username, updated_at: trx.fn.now(),
      }).returning('*');
      const items = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId });
      for (const it of items as any[]) await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      return updated;
    });
  }

  /**
   * TP.6 — propone el orden de pago del día (compromisos financieros → críticos → resto,
   * como ya diseña el motor). Sólo SUGIERE — Tesorería ajusta con `setPriorityRank` antes de
   * autorizar; `releaseLot` exige que todo pago pendiente tenga un orden antes de liberar.
   */
  async suggestPriorityOrder(date: string, username: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
      if (!lot) return [];
      const rows = await trx.raw(`
        WITH crit AS (
          SELECT a.id AS allocation_id,
            bool_or(CASE i.obligation_source
              WHEN 'budget_expense' THEN eo.is_critical
              WHEN 'financial_commitment' THEN fc.is_critical
              WHEN 'supplier_payable' THEN s.is_critical
              -- [TP.18] El derivado trae su critico del MISMO lugar que el capturado
              -- (catalog.suppliers, marca manual con motivo): solo cambia por donde se llega.
              -- (sin acentos graves: esto vive dentro de un template literal de JS)
              WHEN 'kepler_payable' THEN ks.is_critical END) AS any_critical,
            min(CASE i.obligation_source
              WHEN 'budget_expense' THEN eo.original_due_date
              WHEN 'financial_commitment' THEN fc.original_due_date
              WHEN 'supplier_payable' THEN spo.original_due_date
              WHEN 'kepler_payable' THEN kv.vencimiento END) AS min_due
          FROM finance.payment_allocations a
          JOIN finance.payment_allocation_items i ON i.allocation_id = a.id
          LEFT JOIN budget.expense_obligations eo ON i.obligation_source='budget_expense' AND eo.id=i.obligation_id
          LEFT JOIN finance.financial_commitments fc ON i.obligation_source='financial_commitment' AND fc.id=i.obligation_id
          LEFT JOIN commercial.supplier_payment_obligations spo ON i.obligation_source='supplier_payable' AND spo.id=i.obligation_id
          LEFT JOIN catalog.suppliers s ON spo.supplier_id = s.id
          LEFT JOIN analytics.v_supplier_payables kv
                 ON i.obligation_source='kepler_payable'
                AND md5('kepler_payable|'||kv.sucursal||'|'||kv.doc_tipo||'|'||kv.doc_sub||'|'||kv.folio)::uuid = i.obligation_id
          LEFT JOIN catalog.suppliers ks ON ks.code = kv.proveedor
          WHERE a.lot_id = ? AND a.status = 'pending'
          GROUP BY a.id
        )
        SELECT a.id, a.classification, coalesce(c.any_critical,false) AS any_critical, c.min_due, a.amount_assigned
        FROM finance.payment_allocations a JOIN crit c ON c.allocation_id = a.id
        ORDER BY
          CASE a.classification WHEN 'compromiso_financiero' THEN 0 WHEN 'gasto' THEN 1 WHEN 'proveedor_mercancia' THEN 2 ELSE 3 END,
          c.any_critical DESC,
          c.min_due ASC NULLS LAST,
          a.amount_assigned DESC`, [lot.id]);
      let rank = 1;
      const result: { id: string; priority_rank: number }[] = [];
      for (const r of rows.rows as any[]) {
        await trx('finance.payment_allocations').where({ id: r.id }).update({ priority_rank: rank, updated_by: username, updated_at: trx.fn.now() });
        result.push({ id: r.id, priority_rank: rank });
        rank++;
      }
      return result;
    });
  }

  /** Ajuste manual de Tesorería sobre el orden propuesto (define dónde "cortar" si falta presupuesto). */
  async setPriorityRank(allocationId: string, rank: number, username: string) {
    if (!(Number.isInteger(rank) && rank > 0)) throw new BadRequestException('priority_rank debe ser un entero > 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se reordena un pago pendiente');
      const clash = await trx('finance.payment_allocations').where({ lot_id: allocation.lot_id, priority_rank: rank, status: 'pending' }).whereNot('id', allocationId).first();
      if (clash) throw new BadRequestException(`El orden ${rank} ya lo tiene otro pago de este día`);
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId })
        .update({ priority_rank: rank, updated_by: username, updated_at: trx.fn.now() }).returning('*');
      return updated;
    });
  }

  /**
   * Libera (AUTORIZA) el lote del día: exige capacidad definida, consumo <= autorizado
   * (criterio #5), y que TODO pago pendiente tenga orden de pago asignado (TP.6). Genera el
   * folio del lote (`YYMMDD-01` — el "01" es el consecutivo de lote del día, hoy siempre 1
   * porque sólo puede haber un lote por día) y el folio de cada pago (`<folio>-NN`, NN = su
   * orden), SOLO en este momento — nunca al crear el borrador (TP.8).
   */
  async releaseLot(date: string, username: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const capacity = await trx('budget.daily_capacity').where({ tenant_id: tenantId, capacity_date: date }).first();
      if (!capacity) throw new BadRequestException('El día no tiene capacidad definida por Presupuestos — no se puede liberar');
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
      if (!lot) throw new BadRequestException('No hay pagos asignados este día');
      if (lot.status !== 'draft' && lot.status !== 'scheduled' && lot.status !== 'in_prep') {
        throw new BadRequestException(`El día ya está en estado "${lot.status}" — no se puede volver a liberar`);
      }
      const pending = await trx('finance.payment_allocations').where({ lot_id: lot.id, status: 'pending' });
      const withoutRank = pending.filter((a: any) => a.priority_rank == null);
      if (withoutRank.length) throw new BadRequestException(`${withoutRank.length} pago(s) sin orden de pago asignado — usa "proponer orden" o asígnalo a mano antes de autorizar`);
      // `[TP.16]` Dos firmas: Tesorería ordena y PREPARA (método, origen, destino); Gerencia/Dirección
      // autoriza lo que Caja General va a dispersar. Autorizar un pago sin preparar le entregaría a
      // Caja una instrucción sin cuenta de origen ni destino.
      const unprepared = pending.filter((a: AllocationRowLite) => !isPrepared(a));
      if (unprepared.length) throw new BadRequestException(`${unprepared.length} pago(s) sin preparar (método, cuenta de origen y destino) — Tesorería debe prepararlos antes de autorizar`);
      const [{ consumo }] = await trx('finance.payment_allocations').where({ lot_id: lot.id }).whereIn('status', ['pending', 'executed'])
        .select(trx.raw('coalesce(sum(amount_assigned),0) AS consumo'));
      if (Number(consumo) > Number(capacity.authorized_amount) + 0.005) {
        throw new BadRequestException(`Excede la capacidad del día (asignado ${Number(consumo).toFixed(2)} > autorizado ${Number(capacity.authorized_amount).toFixed(2)})`);
      }

      const ymd = date.replace(/-/g, '').slice(2); // YYMMDD
      const lotFolio = lot.folio || `${ymd}-01`;
      for (const a of pending as any[]) {
        if (a.folio) continue;
        const folio = `${lotFolio}-${String(a.priority_rank).padStart(2, '0')}`;
        await trx('finance.payment_allocations').where({ id: a.id }).update({ folio, updated_at: trx.fn.now() });
      }
      const [updated] = await trx('finance.payment_calendar_lots').where({ id: lot.id })
        .update({ status: 'released', folio: lotFolio, released_by: username, released_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
      return updated;
    });
  }

  async closeLot(date: string, username: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
      if (!lot) throw new NotFoundException('No hay lote este día');
      const [updated] = await trx('finance.payment_calendar_lots').where({ id: lot.id })
        .update({ status: 'closed', closed_by: username, closed_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
      return updated;
    });
  }

  // ── Acuerdos de negociación ───────────────────────────────────────────────────────────
  async listAgreements(source: ObligationSource, obligationId: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) =>
      trx('finance.payment_negotiation_agreements').where({ obligation_source: source, obligation_id: obligationId }).orderBy('created_at', 'desc'));
  }

  async createAgreement(dto: CreateAgreementDto, username: string) {
    if (!(dto.obligation_source in CLASSIFICATION_BY_SOURCE)) throw new BadRequestException('obligation_source inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const row = await this.loadObligationRow(trx, tenantId, dto.obligation_source, dto.obligation_id);
      if (!row) throw new NotFoundException('Obligación no encontrada');
      const [agreement] = await trx('finance.payment_negotiation_agreements').insert({
        tenant_id: tenantId, obligation_source: dto.obligation_source, obligation_id: dto.obligation_id,
        responsible_user: dto.responsible_user ?? username, counterpart_text: dto.counterpart_text ?? null,
        committed_date: dto.committed_date ?? null, committed_amount: dto.committed_amount ?? null,
        allows_partial: !!dto.allows_partial, evidence_url: dto.evidence_url ?? null, notes: dto.notes ?? null,
        created_by: username,
      }).returning('*');
      return agreement;
    });
  }
}
