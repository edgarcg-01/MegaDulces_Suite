import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ObjectStorageService, applySmartSearch, toMxDateKey, todayMx } from '@megadulces/platform-core';
import { BUDGET_LEDGER_PORT, type BudgetLedgerPort } from '../budget/budget-ledger.port';
import { GRUPOS_FINANCIEROS, PREFIJOS_FINANCIEROS } from '../creditor-statements/creditor-statements.engine';
import { sqlKeplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';
import { sqlVentanaProntoPago } from '@megadulces/contracts/finance/pronto-pago-ventana';
import { clabeValida } from '@megadulces/contracts/finance/clabe';
import { destinosSugeridos, type FilaComprobanteClabe } from './destino-sugerido';
import { SupplierPaymentAccountsService } from '../supplier-payment-accounts/supplier-payment-accounts.service';
import type { AnticipoDeudaRow, AnticipoRow, DiscountReason, PagosAtrasadosDia, PayableEvidenceFile, PayableEvidenceRow, PaymentCalendarAllocation, PaymentCalendarItemDiscountResult, PaymentCalendarAjusteAlSaldo, PaymentCalendarPartido, PaymentCalendarReprogramado, PaymentCalendarTransferenciaDe, PaymentCalendarWeek, PaymentOriginAccount, SalidaSegunLaDescarga, AbonoQueBajoElSaldo, SupplierCreditRow, SupplierPaymentHabit, SupplierUnappliedCreditRow } from '@megadulces/contracts';
import { leerValidacionDeLosDias, leerValidacionDelDia } from './validacion-pago.sql';
import { leerCfdiConCancelados, leerCfdiDeFacturas } from './cfdi-factura.sql';
import type { CfdiDelRenglon } from '@megadulces/contracts/finance/cfdi-factura';
import { leerRepsDeFacturas } from './rep-de-factura.sql';
import { leerCuentasGasto } from './cuenta-gasto.sql';
import { polizaEgresoDelPago } from '@megadulces/contracts/finance/momento-poliza';
import { leerEnsayoPagoKepler } from './kepler-pago/ensayo-ods.sql';
import type { PaymentCalendarEnsayoKepler, PaymentCalendarEscrituraKepler } from '@megadulces/contracts';
import { escrituraDePagoEncendida } from './kepler-pago/pago-kepler.armador';
import { plantillaPagoDe } from './kepler-pago/kepler-pago-sink.adapter';
import type { ValidacionPago } from '@megadulces/contracts/finance/validacion-pago';
import { assertDescuentoPermitido, descuentoSobreCubierto, descuentosSobreCubierto, lineasDeDescuento, normalizarDescuento, round2, type DescuentosNormalizados, type LineaDescuento } from './descuento-al-pagar';
// `[PGP.120]` El anticipo aplicado desde el Calendario: lo apartado y la verificación de un renglón.
import { SQL_ANTICIPOS_CON_APARTADO, SQL_ANTICIPO_PARA_FACTURA, type FilaAnticipoParaFactura } from './anticipo-calendario.sql';
import { faltaCuentaParaTransferirAnticipo, faltaOrigenMismoBanco, tipoDeAcreedor, warehouseName } from '@megadulces/contracts';
// `[PGP.157]` La caja del anticipo en efectivo (la de su base) y los estados de un día ya autorizado.
import { cajaDeSalidaTexto, ESTADOS_DIA_AUTORIZADO } from '@megadulces/contracts';
import { cierreCompleto, type CierreKeplerPago } from '@megadulces/contracts';
import { SQL_CIERRE_KEPLER, armarCierres, idsParaCierre, type FilaCierreKepler, type ItemParaCierre, type PagoParaCierre } from './cierre-kepler.sql';
import { SALDADA_EN_KEPLER, conLlaveDeKepler, sqlDebeKeplerDeCapturada, sqlDisponibleDeCapturada, type LlaveDeCapturada } from './capturada-kepler.sql';
import {
  DIAS_ANTES, EVENTO_AUNQUE_SALIO, SQL_SALIDA_QUE_LO_PAGO, motivoAunqueSalioValido, motivoParaNoCambiar,
  type AccionSobreElPago, type SalidaQueLoPago,
} from './salio-antes-de-cambiar';
import { leerGuiaFueraDePrograma, ventanaFueraDePrograma } from './fuera-de-programa.sql';
import type { CorteSueltaRow, GuiaFueraDePrograma } from '@megadulces/contracts';
import type { PagoParaCheque } from '@megadulces/contracts';
import { leerCorteSueltas } from './corte-suelta.sql';
import { EVENTO_LIBERADO, decidirVencido, notaLiberado, type MotivoConservar, type ResultadoPagosVencidos } from '@megadulces/contracts';
import {
  EVENTO_REABIERTO, SQL_LIBERADOS_QUE_SALIERON, SQL_PENDIENTES_VENCIDOS, SQL_SALIDA_DE_BANCO, notaReabierto, paramsSalidaDeBanco,
  testigoDelBanco, type FilaLiberadoQueSalio, type FilaPendienteVencido,
} from './pagos-vencidos.sql';
import {
  AUTOR_PAGO_POR_EL_BANCO, EVENTO_PAGADO_POR_EL_BANCO, decidirPagosPorElBanco, segunLaDescarga,
  type CoberturaDeLaDescarga, type ReclamanteDeLaDescarga, type ResultadoPagoPorElBanco, type SalidaBanco,
} from './pago-por-el-banco';
import {
  AUTOR_PAGO_POR_COMPROBANTE, EVENTO_COMPROBANTE_LIGADO, EVENTO_CONFIRMADO_POR_EL_BANCO, EVENTO_PAGADO_POR_COMPROBANTE,
  SQL_COMPROBANTES_POR_APLICAR, SQL_POR_CONFIRMAR_EN_EL_BANCO, moverComprobanteAKepler,
} from './pago-por-comprobante';
import {
  SQL_COBERTURA_DE_LA_DESCARGA, SQL_PENDIENTES_POR_EL_BANCO, SQL_RECLAMANTES_DE_LA_DESCARGA, SQL_SALIDAS_DE_LA_DESCARGA,
  SQL_SALIDAS_LIGADAS, SQL_SALIDAS_POR_EL_BANCO,
} from './pago-por-el-banco.sql';
import {
  AUTOR_AJUSTE_AL_SALDO, EVENTO_AJUSTADO_AL_SALDO, SQL_ABONOS_DE_LAS_FACTURAS, SQL_ARMADO_ORIGINAL, SQL_CANDIDATOS_AJUSTE, SQL_YA_SALIO_DEL_BANCO,
  MOTIVO_NO_AJUSTA_AUTORIZADO, MOTIVO_NO_AJUSTA_HOY_O_PASADO, cargoDeLaFactura, claseDeAbono, debeMenosDelPago, facturasQueDebenMenos, seAjustaSolo,
  MOTIVO_CUBIERTA_POR_OTRA_PARTE, SQL_RENGLONES_VIVOS_DE_LAS_FACTURAS, cubiertoAntesPorRenglon, debeParaEsteRenglon,
  type CargoKepler, type FacturaParaDebeMenos, type ModoAjusteAlSaldo, type OpcionesAjusteAlSaldo, type RenglonVivoDeLaFactura,
} from './debe-menos';
import { ErrorAlPartir, EVENTO_PARTIDO_EN_TRANSFERENCIAS, partirEnTransferencias, type ParteDelPago } from './partir-en-transferencias';
import { SQL_CREDITOS_A_FAVOR } from './creditos-a-favor.sql';
import { AUTOR_PAGO_EN_KEPLER, EVENTO_LIGADO_A_KEPLER, EVENTO_PAGADO_EN_KEPLER, SQL_POR_LIGAR_A_KEPLER, decidirPagoEnKepler } from './pago-en-kepler';

/** `[PGP.117]` Quién libera un pago vencido: queda en `updated_by` y en la bitácora. */
export const AUTOR_PAGOS_VENCIDOS = 'sistema:pagos-vencidos';

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
 * `[TP.16]`/`[PGP.46]` Dígito de control de una CLABE (Banxico).
 *
 * ⛔ **La implementación se mudó a `@megadulces/contracts/finance/clabe`** y acá queda el
 * re-export, que no es pereza: este servicio ahora llama al de cuentas de proveedor, así que si
 * aquél importara `clabeValida` de ESTE archivo quedaría un ciclo de importación — y un ciclo en
 * TypeScript no falla al compilar, falla en ejecución con un `undefined` donde iba la función.
 * Los consumidores (y sus pruebas) siguen importándola de acá sin cambios.
 */
export { clabeValida };

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
  // `[PGP.78]` Un acreedor de Kepler que no está en el catálogo no trae `supplier_id`: con `s:` vacío,
  // dos acreedores distintos de la misma sucursal cabían en UN pago. Sin id va por nombre, como el
  // espejo de la pantalla (`payeeKey`), con su propio prefijo para no juntarse con un gasto.
  const nombre = String(row.beneficiary ?? '').trim().toUpperCase();
  const payee = !esFactura ? `b:${nombre}` : row.supplier_id ? `s:${row.supplier_id}` : `f:${nombre}`;
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
  /** `[PGP.91]` Descuento al pagar: lo cubierto de la factura es `applied_amount + discount_amount`. */
  discount_amount: number | string;
}

/**
 * `[PGP.91]` **Lo que un item CUBRE de su factura**, en SQL: el neto que sale del banco más el
 * descuento que dio el proveedor. Toda suma que diga cuánto de una obligación está reservado o
 * pagado lee ESTO, para que el sobrante descontado no se vuelva a ofrecer mientras la nota de
 * crédito de Kepler no llega. ⛔ Lo que dice cuánto DINERO sale (`amount_assigned`, el tope del
 * día, los PDF, el cruce con el `X-D-26`) sigue leyendo `applied_amount` solo.
 */
const SQL_CUBIERTO = '(i.applied_amount + i.discount_amount)';

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

/**
 * `[PGP.91]` `applied_amount` es el NETO que sale del banco. Los cuatro `discount_*` son el
 * descuento que el proveedor concede AL PAGAR (opcionales: sin ellos, no hay descuento). Los
 * valida y normaliza `normalizarDescuento()` — nunca se insertan crudos.
 */
export interface AllocationItemDto {
  obligation_source: ObligationSource; obligation_id: string; applied_amount: number;
  discount_amount?: number | null; discount_reason?: DiscountReason | null;
  discount_rate?: number | null; discount_note?: string | null;
}
/**
 * `[PGP.91]` Cuerpo de `POST allocations/:id/items/:itemId/descuento` (contrato
 * `PaymentCalendarItemDiscountBody`). Llega como `unknown` a propósito: lo valida
 * `descuentoSobreCubierto()`, no el tipo. ⛔ Es INTERFAZ, no clase: en un `@Body()` emite
 * `Object` en `design:paramtypes`, igual que los otros DTO de este controlador (el caso #414).
 */
export interface ItemDiscountDto { discount_amount?: unknown; discount_reason?: unknown; discount_rate?: unknown; discount_note?: unknown; discounts?: unknown }
export interface CreateAllocationDto { date: string; items: AllocationItemDto[]; priority_rank?: number | null; notes?: string | null }
export interface PrepareAllocationDto {
  payment_method: 'transferencia' | 'cheque' | 'efectivo' | 'cargo_automatico';
  bank_account_id?: string | null; destination_account_text?: string | null;
  cash_register_text?: string | null; reference_text?: string | null;
  supplier_payment_account_id?: string | null;
}
/**
 * `[PGP.190]` Preparar un pago que sale en varias transferencias: UNA cuenta destino (la del proveedor) y, por
 * transferencia, su importe y su cuenta de origen. Campos `unknown`: se validan en el servicio (interfaz, no clase: #414).
 */
export interface PrepararEnTransferenciasDto {
  supplier_payment_account_id?: unknown;
  destination_account_text?: unknown;
  transferencias?: unknown;
}
/** `[TP.16]` Renglón de `finance.payment_allocations` — sólo lo que la vista del día y la autorización leen. */
export interface AllocationRowLite {
  id: string; bank_account_id: string | null; amount_assigned: number | string; payment_method: string | null;
  [col: string]: unknown;
}
/**
 * `[PGP.113]` Un pago con su día: el día (`lot_date`, AAAA-MM-DD) y el estado del día (`lot_status`). La
 * bandeja junta pagos de varios días, y un día autorizado completo (regla vieja) autoriza a sus pagos.
 */
type FilaDePago = AllocationRowLite & {
  lot_date: string; lot_status: string | null; status: string; classification: string;
  authorized_at?: Date | string | null; created_at?: Date | string | null;
};
/** `[TP.15]` Lo que el candado de saldo lee de una obligación a proveedor (columnas de la mig 20261016002604). */
/** `[PGP.76]` El turno que quedó a cada pago del día después de reordenarlo. */
export interface DayOrderRank { id: string; priority_rank: number }
interface KeplerLinkedRow {
  supplier_id?: string; reserved_amount: number | string;
  /** El código del acreedor en Kepler; sólo lo trae la deuda derivada (`kepler_payable`). */
  kepler_proveedor?: string | null;
  kepler_sucursal?: string | null; kepler_folio?: string | null;
  kepler_doc_tipo?: number | string | null; kepler_doc_sub?: number | string | null;
}
export type ReprogramReason = 'cuenta_erronea' | 'falla_sistema_banco' | 'pago_devuelto' | 'presupuesto_recortado' | 'otro';
export const REPROGRAM_REASONS: ReprogramReason[] = ['cuenta_erronea', 'falla_sistema_banco', 'pago_devuelto', 'presupuesto_recortado', 'otro'];
// TP.6 — un lote AUTORIZADO (o más adelante) ya cerró su alcance: no admite nuevos pagos.
// Reprogramar/fallar/ejecutar una allocation EXISTENTE sigue permitido (son hechos de ejecución,
// no de autorización) — lo que se bloquea es agregar pagos NUEVOS al lote ya autorizado.
// `[PGP.157]` Los mismos tres estados que lee Caja General para saber si un anticipo ya se autorizó: una sola lista.
const LOCKED_LOT_STATUSES = new Set(ESTADOS_DIA_AUTORIZADO);

/**
 * `[PGP.113]` **Un pago AUTORIZADO queda congelado.** Cambiar su forma de pago, sus facturas o su
 * descuento cambiaría lo que Dirección firmó. Se le quita la autorización, se cambia y se vuelve a
 * autorizar. (El candado del DÍA autorizado, `LOCKED_LOT_STATUSES`, sigue para los días que se
 * autorizaron completos con la regla vieja.)
 */
function assertSinAutorizar(a: { authorized_at?: unknown; authorized_by?: string | null }): void {
  if (a.authorized_at) {
    throw new BadRequestException(`Este pago ya lo autorizó ${a.authorized_by ?? 'Dirección'}: quítale la autorización para cambiarlo y que lo vuelvan a autorizar.`);
  }
}
const PESOS_MX = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });

/** `[PGP.36]` La fila que devuelve la consulta de etiquetas del origen derivado, con su ventana. */
interface VentanaRow {
  id: string; beneficiary: string; concept: string;
  supplier_id: string | null; branch_code: string | null; vence: string | null;
  pronto_fecha_limite: string | null; pronto_tasa: number | string | null;
  pronto_beneficio: number | string | null; pronto_estado: string | null;
  entity_ref: string | null; doc_ref: string | null;
  /** `[PGP.120]` El código del acreedor en Kepler: con la sucursal, casa la factura con sus anticipos. */
  payee_code: string | null;
  /** `[PGP.147]` Lo que la factura debe hoy en Kepler. */
  kepler_debe: number | string | null;
}
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
/**
 * `[PGP.47]` **Un folio leído por OCR que no puede ser un folio.**
 *
 * ⛔ Se descubrió MIRANDO EL PAPEL, no con una compuerta: el renglón de BOTANAS Y CEREALES DE
 * ZAMORA publicaba como «folio externo» el texto `ABF3D7B3-0A61-42C3-8BFF-B871 3C62924B`. El OCR
 * del comprobante a veces lee el **UUID fiscal** y lo guarda en `ocr_folio`.
 *
 * Medido el 2026-11-03 sobre los 35 folios por OCR del día: **5 son ilegibles (14.3 %)** — cuatro
 * UUID y un `-1649` cortado. Los otros 30 son folios de verdad (`F963114`, `AE 263061`,
 * `FDA 56779`), así que tirar el OCR entero costaría más de lo que ahorra: la cobertura del folio
 * externo caería del 74.3 % al 16 %.
 *
 * Lo que NO se hace: moverlo a `uuid_fiscal`. Ese campo afirma que el UUID está **casado** con el
 * documento, y una lectura de una foto no lo está. La línea queda «sin folio externo legible»,
 * que el control del expediente ya cuenta y explica (ADR-056: se declara, no se rellena).
 */
export function folioExternoLegible(leido: string | null | undefined): string | null {
  const s = String(leido ?? '').trim();
  if (!s) return null;
  // Un UUID es el folio FISCAL, no el folio. Se admiten los que el OCR parte con espacios.
  if (/^[0-9a-f]{8}[\s-]+[0-9a-f-\s]{20,}$/i.test(s) && s.replace(/[^0-9a-f]/gi, '').length >= 30) return null;
  if (!/^[0-9A-Za-z]/.test(s)) return null;        // `-1649`: lectura cortada por delante.
  if (s.length > 24) return null;                   // ninguna factura numera así de largo.
  return s;
}

/**
 * `[PGP.47]` **Una línea del expediente**: una factura de un pago, con lo que hace falta para
 * hallar su papel en el archivo. Vive acá y no en `libs/contracts` porque todavía no cruza la
 * frontera HTTP — la consume el PDF del Calendario, en esta misma lib. Si una pantalla la
 * necesita, se muda a `contracts` (ADR-056: el primitivo no se queda escondido en un servicio).
 */
export interface ExpedienteLinea {
  allocation_id: string;
  obligation_source: ObligationSource;
  obligation_id: string;
  /** Lo que ESTE pago abona a esta factura. No es el importe de la factura. */
  se_paga: number;
  /**
   * `[PGP.91]` Lo que el proveedor descontó al pagar (0 si nada). `se_paga` es el NETO; lo que la
   * factura queda cubierta es `se_paga + descuento`. Sin esto, una factura pagada con su descuento
   * se contaba en el control como «se paga menos de lo que se debe», junto a los pagos parciales.
   */
  descuento: number;
  /** Código de la sucursal. ⛔ Se publica por NOMBRE (`warehouseName`), nunca «01». */
  sucursal: string | null;
  /** El folio del documento en Kepler — con el que el ERP lo conoce. Cobertura medida: 85.4 %. */
  folio_interno: string | null;
  /**
   * El folio impreso en el papel del proveedor. Con las tres fuentes abajo, **100 % de las
   * líneas del 2026-11-03** (25 del CFDI, 30 del OCR, 14 del ERP).
   */
  folio_externo: string | null;
  /**
   * De dónde salió, porque las tres **no valen lo mismo** y quien archiva tiene que saber cuál
   * está leyendo (ADR-056):
   *
   *  - `cfdi` — serie y folio del comprobante **timbrado**, casado por UUID. Es el dato duro.
   *  - `ocr`  — lectura automática de la foto del comprobante. Acierta mucho pero **no está
   *    verificada**, y 5 de 35 del día eran ilegibles (ver `folioExternoLegible`).
   *  - `erp`  — lo que tecleó quien capturó la factura (`kdxe.c16`), con su prefijo tal cual.
   *    ⭐ Medido el 2026-11-03 sobre los **43 pares casados por UUID** (no por ancla difusa):
   *    **22 terminan con el folio completo del CFDI (51.2 %)** y **28 con sus últimos cuatro
   *    (65.1 %)**, con **placebo 0** en los dos casos — el folio interno de Kepler nunca aparece
   *    ahí. ⛔ Corrige una medición mía anterior que lo dio por ruido («4 de 219»): aquella
   *    anclaba por RFC + importe, lo que infla los pares, y comparaba contra una concatenación
   *    de serie y folio que estaba mal armada.
   */
  folio_externo_fuente: 'cfdi' | 'ocr' | 'erp' | 'ninguna' | null;
  /** Folio de la orden de compra que originó la entrada. Medido: 100 de 142 con comprobante. */
  orden_compra: string | null;
  fecha_recepcion: string | null;
  /**
   * La fecha de la factura. ⭐ **Del CFDI cuando está identificado**, porque `kdxe.c7` es cuándo
   * se registró la cuenta por pagar y no cuándo se emitió el comprobante: medido el 2026-11-03,
   * **difieren en 39 de 43 líneas (91 %)**, hasta 179 días. La que está impresa en el papel que
   * se archiva es la del CFDI.
   */
  fecha: string | null;
  fecha_fuente: 'cfdi' | 'erp' | 'ninguna' | null;
  vencimiento: string | null;
  /** Importe original del documento y lo que todavía se debe de él. **El del ERP**, siempre. */
  importe: number | null;
  pendiente: number | null;
  /**
   * Lo que dice el comprobante timbrado, **sólo para contrastar** (11 de 43 difieren del ERP).
   * ⛔ No reemplaza a `importe`: el que decide cuánto se paga es el del ERP, que es contra lo que
   * el acreedor nos tiene registrada la deuda. Una diferencia es un hallazgo para una persona.
   */
  importe_cfdi: number | null;
  /** `kdxe.c16`, captura MANUAL. No es el folio del proveedor: ver `detalleExpediente`. */
  referencia: string | null;
  /** ⭐ Del emisor del CFDI cuando está identificado; si no, el que resolvió la vista. */
  rfc: string | null;
  rfc_fuente: 'cfdi' | 'kepler' | 'nombre' | 'ninguna' | null;
  /** Lo que Kepler tiene capturado cuando CONTRADICE al comprobante timbrado (ADR-108). */
  rfc_discrepa: string | null;
  /** Qué papel existe hoy. `no_aplica` = no hay factura del ERP detrás (obligación propia). */
  papel: 'pdf' | 'uuid' | 'ninguna' | 'no_aplica';
  /** El UUID del SAT, y **sólo** cuando `papel === 'uuid'`. Ver la trampa en `detalleExpediente`. */
  uuid_fiscal: string | null;
  /** El ERP ya no debe este documento: no se puede pagar. Medido: 33 de 226 líneas vivas. */
  saldada: boolean;
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
    // `[PGP.46]` El catalogo de cuentas, para que la CLABE tecleada al preparar quede pedida de
    // alta. OPCIONAL por la misma razon que `storage`, y ademas porque lo que hace es ACCESORIO al
    // pago: si no esta cableado, el pago se prepara igual y lo unico que se pierde es no volver a
    // teclear 18 digitos. Al reves —tumbar el pago porque el catalogo no respondio— seria un
    // remedio peor que la enfermedad.
    @Optional() private readonly cuentas?: SupplierPaymentAccountsService,
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
    // `[PGP.91]` Reservado y pagado son lo CUBIERTO (neto + descuento al pagar), no sólo el neto:
    // una factura pagada con 3 % de descuento queda saldada aquí, y el 3 % no vuelve a ofrecerse
    // mientras Kepler no emite la nota de crédito. Respeta el CHECK reservado + pagado ≤ original
    // de las tres tablas porque lo cubierto nunca pasa del disponible (`createAllocation`/`addItem`).
    const [agg] = await trx('finance.payment_allocation_items as i')
      .join('finance.payment_allocations as a', 'a.id', 'i.allocation_id')
      .where({ 'i.obligation_source': source, 'i.obligation_id': id })
      .select(
        trx.raw(`coalesce(sum(${SQL_CUBIERTO}) FILTER (WHERE a.status = 'pending'), 0) AS reserved`),
        trx.raw(`coalesce(sum(${SQL_CUBIERTO}) FILTER (WHERE a.status = 'executed'), 0) AS paid`),
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
   * `netoConNotaYaAplicada` (`[PGP.91]`, sólo al ejecutar un item con descuento): el neto del item;
   * si el tope de Kepler es justo ese neto (±1 centavo), la nota de crédito del descuento ya llegó y pasa.
   */
  private async assertKeplerBalance(trx: Knex.Transaction, source: ObligationSource, row: KeplerLinkedRow, applied: number,
    alreadyReserved = Number(row.reserved_amount), netoConNotaYaAplicada?: number) {
    // `[TP.18]` Vale para los dos orígenes de factura: la capturada trae las columnas `kepler_*`
    // desde la mig `20261016002604`, y la derivada las trae por construcción.
    if ((source !== 'supplier_payable' && source !== 'kepler_payable') || !row.kepler_folio) return;
    // `[PGP.78]` La derivada trae el código de Kepler y se busca por él. Ir por el catálogo dejaba
    // en cero a un acreedor que no está dado de alta (medido 2026-11-05: 4 facturas, 3 acreedores)
    // y la pantalla decía «Kepler ya no tiene saldo» de una factura que Kepler sí debe.
    const [doc] = await trx('analytics.v_supplier_payables')
      .where({ sucursal: row.kepler_sucursal, folio: row.kepler_folio, doc_tipo: row.kepler_doc_tipo, doc_sub: row.kepler_doc_sub })
      .modify((w) => {
        if (row.kepler_proveedor) w.where('proveedor', row.kepler_proveedor);
        else w.whereIn('proveedor', trx('catalog.suppliers').select('code').where({ id: row.supplier_id }));
      })
      .sum({ pendiente: 'pendiente' });
    const pendiente = Number(doc?.pendiente ?? 0);
    const tope = pendiente - alreadyReserved;
    // `[PGP.91]` Pago con descuento cuya nota de crédito ya llegó: Kepler debe EXACTAMENTE el neto.
    if (netoConNotaYaAplicada !== undefined && Math.abs(tope - netoConNotaYaAplicada) <= 0.01) return;
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
        'v.proveedor AS kepler_proveedor',
      );
    if (!row) return undefined;
    // Lo ya comprometido sale de los items, que son la fuente de verdad de la reserva para los
    // CUATRO orígenes — acá, además, es el único lugar donde existe.
    // `[PGP.91]` Lo cubierto (neto + descuento al pagar), igual que `recalcObligation`.
    const [agg] = await trx('finance.payment_allocation_items as i')
      .join('finance.payment_allocations as a', 'a.id', 'i.allocation_id')
      .where({ 'i.obligation_source': source, 'i.obligation_id': id })
      .select(
        trx.raw(`coalesce(sum(${SQL_CUBIERTO}) FILTER (WHERE a.status = 'pending'), 0) AS reserved`),
        trx.raw(`coalesce(sum(${SQL_CUBIERTO}) FILTER (WHERE a.status = 'executed'), 0) AS paid`),
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
    // `[PGP.17]` el LEFT JOIN pre-agregado en vez del EXISTS correlacionado (882 → 394 ms, 2026-10-26); `[PGP.141]` agrega
    // `por_sucursal`. La consulta vive en `creditos-a-favor.sql.ts` (la misma que se mide contra prod).
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(SQL_CREDITOS_A_FAVOR, [tenantId, tenantId]);
      return rows;
    });
  }

  /**
   * `[PGP.113]` Las facturas «por confirmar» (`[PGP.13]`) que Oficinas NUNCA registró: sin copia, sin
   * pago y sin nota aplicada (`[PGP.147]`). La pantalla las deja programar a mano. Regla en
   * `libs/contracts/src/finance/corte-suelta.contract.ts`; medido 2026-11-18: 73 de 208, mediana ~500 ms.
   */
  async listCorteSueltas(): Promise<CorteSueltaRow[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => leerCorteSueltas(trx, tenantId));
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
   * `[PGP.118]` **Los anticipos sin aplicar** (`X-D-60`), todos los acreedores, documento por
   * documento. Medido en prod el 2026-11-13: 64 documentos, 82-106 ms; `a_favor` = `kdxe.c20` en
   * 64/64. La deuda viva de esos acreedores va APARTE (`listAnticipoDeuda`): juntas pasan de 500 ms.
   *
   * ⛔ No filtra por tipo de acreedor: devuelve también gasto (`G*`) y tarjeta (`TC*`), y la pantalla
   *    los separa (D2). Filtrarlos acá haría que el total deje de cuadrar con Kepler.
   */
  async listAnticipos(): Promise<AnticipoRow[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    // `[PGP.120]` Con lo apartado en pagos pendientes del Calendario (84-88 ms en prod, 2026-11-13).
    return this.tk.run(async (trx) => (await trx.raw(SQL_ANTICIPOS_CON_APARTADO, [tenantId, tenantId])).rows);
  }

  /**
   * `[PGP.118]` Lo que le debemos a los acreedores que nos pidió la pantalla (los de anticipo de
   * mercancía). Va en diferido porque `v_supplier_payables` tiene un piso medido de ~390 ms aun con
   * el predicado por acreedor. La pantalla manda los códigos que ya tiene: así no se vuelve a leer
   * la vista de créditos.
   * `[PGP.120]` Por acreedor Y SUCURSAL: un anticipo sólo se aplica contra facturas de su sucursal.
   */
  async listAnticipoDeuda(proveedores: readonly string[]): Promise<AnticipoDeudaRow[]> {
    const codes = [...new Set(proveedores.map((p) => String(p ?? '').trim()).filter((p) => /^[A-Za-z0-9]{1,20}$/.test(p)))].slice(0, 300);
    if (!codes.length) return [];
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT btrim(p.proveedor) AS proveedor, p.sucursal, count(*)::int AS facturas, sum(p.pendiente)::float8 AS deuda,
                to_char(min(p.vencimiento), 'YYYY-MM-DD') AS vence_primero
           FROM analytics.v_supplier_payables p
          WHERE p.tenant_id = ? AND p.pendiente > 0.005 AND p.proveedor = ANY(?::text[])
          GROUP BY 1, 2`,
        [tenantId, codes],
      );
      return rows;
    });
  }

  /**
   * `[PGP.120]` **Verifica cada renglón «Anticipo» de una factura contra Kepler** antes de guardarlo:
   * que la factura sea de Kepler y de la MISMA sucursal del anticipo, que el anticipo exista y sea del
   * mismo acreedor (de mercancía, D2), y que alcance: lo que Kepler guarda menos lo ya apartado en
   * otros pagos pendientes. Un candado por anticipo (`pg_advisory_xact_lock`) serializa a dos personas
   * que aplican el mismo anticipo a la vez: la segunda lee lo apartado por la primera.
   */
  private async verificarAnticipos(
    trx: Knex.Transaction, tenantId: string,
    item: { id: string; obligation_source: string; obligation_id: string }, lines: LineaDescuento[],
  ): Promise<void> {
    const anticipos = lines.filter((l) => l.reason === 'anticipo');
    if (!anticipos.length) return;
    if (item.obligation_source !== 'kepler_payable') {
      throw new BadRequestException('Un anticipo sólo se aplica contra una factura de Kepler: ésta no viene de Kepler.');
    }
    for (const l of anticipos) {
      const ref = l.anticipo;
      if (!ref) throw new BadRequestException('El renglón de anticipo necesita su documento de Kepler (sucursal y folio).');
      const suc = warehouseName(ref.sucursal);
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`pgp120:${tenantId}:${ref.sucursal}:${ref.folio}`]);
      const { rows: [f] } = await trx.raw(SQL_ANTICIPO_PARA_FACTURA, [
        tenantId, item.id, ref.sucursal, item.obligation_id, tenantId, ref.sucursal, ref.folio, ref.sucursal, ref.folio,
      ]) as { rows: FilaAnticipoParaFactura[] };
      if (!f || f.ant_n === 0) throw new BadRequestException(`El anticipo ${ref.folio} de ${suc} no existe en Kepler.`);
      if (f.ant_n > 1) throw new BadRequestException(`Hay ${f.ant_n} anticipos con el folio ${ref.folio} en ${suc}: no se puede saber cuál es.`);
      if (f.fac_n === 0) throw new BadRequestException(`El anticipo ${ref.folio} es de ${suc} y esta factura no: en Kepler un anticipo sólo se aplica contra facturas de su misma sucursal.`);
      if ((f.fac_acreedor ?? '').toUpperCase() !== (f.ant_proveedor ?? '').toUpperCase()) {
        throw new BadRequestException(`El anticipo ${ref.folio} es de otro acreedor: sólo se aplica contra facturas del acreedor al que se le dio.`);
      }
      if (tipoDeAcreedor(f.ant_proveedor) !== 'mercancia') {
        throw new BadRequestException(`El anticipo ${ref.folio} es de gasto o tarjeta: no se aplica contra compras.`);
      }
      const aFavor = round2(Number(f.a_favor ?? 0));
      const apartado = round2(Number(f.apartado ?? 0));
      const disponible = round2(Math.max(0, aFavor - apartado));
      if (l.amount > disponible + 0.005) {
        throw new BadRequestException(aFavor <= 0.005
          ? `El anticipo ${ref.folio} ya se aplicó entero en Kepler.`
          : `Del anticipo ${ref.folio} quedan $${disponible.toFixed(2)} por aplicar ($${aFavor.toFixed(2)} en Kepler${apartado > 0 ? `, $${apartado.toFixed(2)} ya apartados en otros pagos del Calendario` : ''}); no alcanza para $${l.amount.toFixed(2)}.`);
      }
    }
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
      // `[PGP.153]` Sólo las facturas de este acreedor (las llaves salen de la misma vista de saldos que usa la evidencia).
      const ev = await this.fuenteEvidencia(trx, trx.raw(
        `ARRAY(SELECT v.sucursal || '|' || v.doc_tipo || '|' || v.doc_sub || '|' || btrim(v.folio) FROM analytics.v_supplier_payables v WHERE v.tenant_id = ? AND v.proveedor = ?)`,
        [tenantId, code]));
      const { rows } = await trx.raw(
        `SELECT e.sucursal, e.doc_tipo, e.doc_sub, e.folio, e.proveedor,
                'oblig:' || e.sucursal || '|' || e.doc_tipo || '|' || e.doc_sub || '|' || btrim(e.folio) AS entity_ref,
                e.pendiente::float8 AS pendiente, e.evidencia, e.ref_evidencia,
                e.puntaje, e.senales, e.motivo, e.rfc, e.rfc_fuente, e.rfc_discrepa
           FROM ${ev.sql} e
          WHERE e.tenant_id = ? AND e.proveedor = ?
          ORDER BY e.evidencia, e.puntaje DESC, e.pendiente DESC
          LIMIT 500`,
        [...ev.binds, tenantId, code],
      );
      return rows;
    });
  }

  /**
   * `[PGP.152]`/`[PGP.153]` De dónde se lee la evidencia: la función por llaves si la migración ya está aplicada (calcula
   * SÓLO esas facturas), o la vista de siempre si no (la API no exige lo que la base todavía no tiene). Con la función,
   * ningún uso de la app lee la vista completa: sin materializar `cfd` (`[PGP.153]`) la vista completa es más lenta.
   */
  private async fuenteEvidencia(trx: Knex.Transaction, llaves: Knex.Raw | string[]): Promise<{ sql: string; binds: Knex.RawBinding[] }> {
    const hay = (await trx.raw(`SELECT to_regprocedure('analytics.payable_evidence(text[])') IS NOT NULL AS h`)).rows[0]?.h;
    if (!hay) return { sql: 'analytics.v_payable_evidence', binds: [] };
    return Array.isArray(llaves)
      ? { sql: 'analytics.payable_evidence(?::text[])', binds: [llaves] }
      : { sql: 'analytics.payable_evidence(?)', binds: [llaves] };
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
    const COLS = `e.sucursal, e.doc_tipo, e.doc_sub, e.folio, e.proveedor,
                'oblig:' || e.sucursal || '|' || e.doc_tipo || '|' || e.doc_sub || '|' || btrim(e.folio) AS entity_ref,
                e.pendiente::float8 AS pendiente, e.evidencia, e.ref_evidencia,
                e.puntaje, e.senales, e.motivo, e.rfc, e.rfc_fuente, e.rfc_discrepa`;
    return this.tk.run(async (trx) => {
      /*
       * `[PGP.152]` La evidencia se calcula SÓLO para estas facturas (`analytics.payable_evidence(p_llaves)`, el MISMO
       * cuerpo que la vista con el filtro dentro): la vista cruzaba las ~3,200 facturas abiertas contra 172 mil CFDI y
       * filtraba al final. Medido en prod: 3.7–4.6 s → ~2 s, 196 de 196 filas idénticas. Sin la migración aplicada
       * (`fuenteEvidencia`), la consulta de siempre: la API no exige lo que la base todavía no tiene.
       */
      const ev = await this.fuenteEvidencia(trx, llaves);
      if (ev.binds.length) return (await trx.raw(`SELECT ${COLS} FROM ${ev.sql} e WHERE e.tenant_id = ?`, [...ev.binds, tenantId])).rows;
      const { rows } = await trx.raw(
        `SELECT ${COLS}
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
    /**
     * `[PGP.59]` **Una LLAVE del bucket no es una URL.** Cuando `signFiles` no puede firmar
     * (almacén sin configurar, o la firma falla) devuelve el archivo con su llave
     * (`finance/<tenant>/goods-receipts/<uuid>.pdf`) en `url`, y la pantalla la abría: el navegador
     * se la pedía al propio sitio y la persona veía «Cannot GET …» (visto en Pagos el 2026-11-04;
     * es el mismo síntoma que `ce732b9b5` arregló en el visor de documentos, y que Pagos no
     * heredó). Sólo sale lo que de verdad se puede abrir; si había archivos y ninguno se firmó,
     * se DICE con su causa (ADR-056) en lugar de devolver una lista que parece servible.
     */
    const abribles = firmados.map((f) => {
      const x = f as { url?: string; name?: string; role?: string; kind?: string };
      return { url: x.url ?? '', name: x.name ?? null, role: x.role ?? null, kind: x.kind ?? null };
    }).filter((f) => /^https?:\/\//i.test(f.url));
    if (files.length && !abribles.length) {
      throw new ServiceUnavailableException(
        'La factura está guardada, pero el servidor no pudo preparar su enlace de lectura (almacén de archivos sin configurar o la firma falló). No se arregla desde aquí: avisa a Sistemas.');
    }
    return abribles;
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
     *  · `cercania` — `[PGP.50]` lo más cercano a HOY primero, vencido o por vencer. Con el techo
     *    de 1,000, `vencimiento` entrega las 1,000 MÁS VIEJAS: medido el 2026-11-03 sobre la deuda
     *    de Kepler, el corte caía en el 1-jun-2026 y **las 160 facturas que vencen esta semana
     *    ($9,022,851.47) quedaban fuera, 0 de 160**; con `cercania`, 160 de 160 (ventana
     *    7-oct a 30-nov). Es el orden de la pantalla del Calendario; el default sigue siendo
     *    `vencimiento` para no mover a nadie más.
     */
    orden?: 'vencimiento' | 'descuento' | 'cercania';
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
        // `[PGP.197]` Lo que Kepler todavía debe de su factura: la que Tesorería ya pagó por fuera no se vuelve a
        // ofrecer (CD031, 13-nov: pagada dos veces). Sólo las obligaciones que traen su llave; 85 ms las 38.
        .joinRaw(`LEFT JOIN LATERAL (${sqlDebeKeplerDeCapturada('o')}) kd ON o.status IN ('pending', 'partial')`)
        .select(
          trx.raw(`'supplier_payable'::text AS obligation_source`), 'o.id AS obligation_id',
          's.name AS beneficiary', trx.raw(`coalesce(o.concept, o.invoice_folio, 'Mercancía')::text AS concept`),
          trx.raw(`'proveedor_mercancia'::text AS classification`), trx.raw(`'mercancia'::text AS subtype`),
          's.code AS area_code', 'o.original_due_date', 'o.negotiated_date', 'o.original_amount',
          'o.reserved_amount', 'o.paid_amount',
          trx.raw(`${sqlDisponibleDeCapturada('o', 'kd')} AS available_amount`),
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
        // `[PGP.91]` Suma lo CUBIERTO (neto + descuento al pagar): el sobrante descontado no se
        // vuelve a ofrecer mientras la nota de crédito de Kepler no llega.
        .joinRaw(`LEFT JOIN (
          SELECT i.obligation_id,
                 coalesce(sum(${SQL_CUBIERTO}) FILTER (WHERE a.status = 'pending'), 0) AS reserved,
                 coalesce(sum(${SQL_CUBIERTO}) FILTER (WHERE a.status = 'executed'), 0) AS paid
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
        // `[BU.2.1]` El mismo motor que ya usan 22 pantallas (`applySmartSearch`): cada palabra
        // de la búsqueda tiene que aparecer en ALGÚN lado, en cualquier orden, sin acentos, y los
        // números pegan por dígitos. Así «delicias 396 248» = proveedor **delicias** + folio **396**
        // + monto **248** en una sola consulta, que el `whereILike('%texto%')` anterior no podía:
        // buscaba la frase entera y multi-palabra siempre daba vacío.
        //
        // El monto va TAMBIÉN en `columns` (no sólo en `numeric`): la vía numérica del motor sólo
        // se activa cuando TODA la consulta es un número, así que para que «248» pegue dentro de
        // una búsqueda mixta, los dígitos del importe tienen que estar en el pajar de texto.
        applySmartSearch(base, q.search, {
          columns: ['ob.beneficiary', 'ob.concept', 'ob.doc_ref', 'ob.payee_code', 'ob.original_amount'],
          numeric: ['ob.original_amount', 'ob.available_amount'],
        });
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
        : q.orden === 'cercania'
          // `[PGP.50]` Días de distancia a hoy (CDMX), en los dos sentidos; a igualdad, lo de más monto.
          ? `abs(ob.original_due_date::date - (now() AT TIME ZONE 'America/Mexico_City')::date) ASC NULLS LAST, ob.available_amount DESC`
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
    return this.tk.run(async (trx) => (await this.armarDias(trx, tenantId, [date]))?.armadas ?? []);
  }

  /**
   * `[PGP.165]` **Un pago con lo que su cheque necesita**: el día del Calendario (la fecha del cheque), el banco de su
   * cuenta (el papel) y el pago ARMADO como lo ve la pantalla — el mismo beneficiario y las mismas facturas, no una
   * segunda lectura que pudiera decir otra cosa. Null si no existe, es de otro tenant o está cancelado. Sólo lectura.
   */
  async pagoParaCheque(allocationId: string): Promise<(PagoParaCheque & { dia: string }) | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(allocationId ?? ''))) return null;
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const r = (await trx('finance.payment_allocations as a')
        .join('finance.payment_calendar_lots as l', 'l.id', 'a.lot_id')
        .leftJoin('finance.bank_accounts as ba', 'ba.id', 'a.bank_account_id')
        .where({ 'a.id': allocationId, 'a.tenant_id': tenantId })
        .whereNot('a.status', 'cancelled')
        .first(trx.raw("to_char(l.lot_date, 'YYYY-MM-DD') AS dia"), 'ba.bank AS banco', 'a.payment_method', 'a.reference_text',
          // El importe como TEXTO del numeric: los centavos se leen exactos, sin pasar por un flotante.
          trx.raw('a.amount_assigned::text AS amount_assigned'))) as
        { dia: string; banco: string | null; payment_method: string | null; reference_text: string | null; amount_assigned: string } | undefined;
      if (!r) return null;
      // El beneficiario y las facturas, del pago ARMADO: lo que la pantalla muestra es lo que se imprime.
      const pago = (await this.armarDias(trx, tenantId, [r.dia]))?.armadas.find((x) => x.id === allocationId);
      if (!pago) return null;
      return {
        dia: r.dia,
        banco: r.banco ?? null,
        payment_method: r.payment_method ?? null,
        reference_text: r.reference_text ?? null,
        amount_assigned: r.amount_assigned,
        items: (pago.items ?? []).map((it) => ({ applied_amount: it.applied_amount, beneficiary: (it.beneficiary ?? null) as string | null })),
      };
    });
  }

  /** `[PGP.151]` Los pagos de varios días, repartidos por día (para la semana). */
  private async pagosDeLosDias(trx: Knex.Transaction, tenantId: string, dias: string[]) {
    const r = await this.armarDias(trx, tenantId, dias);
    const out = new Map(dias.map((d) => [d, [] as NonNullable<typeof r>['armadas']]));
    // `armarFilas` devuelve en el orden de entrada: se reparte por día sin reordenar.
    r?.armadas.forEach((x, i) => out.get(r.filas[i].lot_date)?.push(x));
    return out;
  }

  /**
   * Los pagos (sin cancelar) de UNO O VARIOS días, armados en UNA pasada de `armarFilas`.
   *
   * `[PGP.151]` **Cambiar de semana tardaba 3.5–5.5 s** (`GET weeks/:date`, medido en prod 10 al 18-nov; 260 llamadas
   * el 18). La semana armaba cada día por separado, y cada armado repetía las lecturas que no dependen del día: la
   * etiqueta de las facturas de Kepler (`v_supplier_payables` filtrada por su llave md5, ~425 ms cada vez, corrida 4
   * veces = 1.7 s de 3.1 s), el cierre en Kepler (4 veces), el RFC (2). Ahora es una pasada para los siete días.
   *
   * La regla de cada pago es la misma que tenía el día: su día y el estado de su día (`[PGP.113]`); el CFDI (~330 ms)
   * sólo en un día que ya llegó o autorizado completo, o en un pago autorizado o pagado (`[PGP.108]`); la validación
   * contra el banco, en cada día que tiene pagos (`[PGP.104]`). El orden: el del día (prioridad, luego alta).
   */
  private async armarDias(trx: Knex.Transaction, tenantId: string, dias: string[]) {
    const lots = (await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId }).whereIn('lot_date', dias)
      .select('id', 'status', trx.raw("to_char(lot_date, 'YYYY-MM-DD') AS dia"))) as { id: string; status: string | null; dia: string }[];
    if (!lots.length) return null;
    const porLote = new Map(lots.map((l) => [l.id, l]));
    const allocations = await trx('finance.payment_allocations').whereIn('lot_id', lots.map((l) => l.id)).whereNot('status', 'cancelled')
      .orderByRaw('priority_rank ASC NULLS LAST').orderBy('created_at', 'asc');
    if (!allocations.length) return null;
    // `[PGP.113]` El día es un caso de la bandeja: los mismos renglones, con su día y el estado de su día.
    const filas: FilaDePago[] = (allocations as FilaDePago[]).map((a) => {
      const l = porLote.get(String(a['lot_id']))!;
      return { ...a, lot_date: l.dia, lot_status: (l.status ?? null) as string | null };
    });
    const hoy = todayMx();
    const armadas = await this.armarFilas(trx, tenantId, filas, {
      // `[PGP.108]` El CFDI cuesta ~330 ms: sólo en un día que ya llegó o autorizado completo, y
      // `[PGP.113]` en un pago autorizado o pagado (los que van a tener póliza).
      conCfdi: (a) => a.lot_date <= hoy || LOCKED_LOT_STATUSES.has(a.lot_status ?? '') || !!a.authorized_at || a.status === 'executed',
      validarDias: [...new Set(filas.map((f) => f.lot_date))],
    });
    return { filas, armadas };
  }

  /**
   * `[PGP.113]` **La bandeja: cada pago en su etapa, de todos los días.** El pago avanza solo
   * (Edgar, 2026-11-10), así que la pantalla ya no entra por el día: entra por lo que le falta a
   * cada pago. Trae los pendientes y rebotados de cualquier día (los de días pasados son el atraso,
   * y es lo primero que hay que ver) y los pagados de los últimos `diasPagados` días (lo que falta
   * registrar en Kepler y lo recién terminado).
   *
   * Los renglones son los MISMOS que los del día (`armarFilas`): una regla, dos vistas. Para no
   * pagar el CFDI de 170 pagos, sólo se lee en los autorizados y pagados (los que van a tener
   * póliza); la validación contra el banco, sólo en los días que tienen un pago autorizado o pagado.
   */
  async bandeja(diasPagados = 30): Promise<{ pagos: unknown[]; pagados_desde: string; generado: string }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = todayMx();
    const desde = toMxDateKey(new Date(Date.parse(`${hoy}T12:00:00Z`) - Math.max(1, Math.min(120, diasPagados)) * 86_400_000)) || hoy;
    return this.tk.run(async (trx) => {
      const filas = (await trx.raw(
        `SELECT a.*, to_char(l.lot_date, 'YYYY-MM-DD') AS lot_date, l.status AS lot_status
           FROM finance.payment_allocations a
           JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
          WHERE a.tenant_id = ? AND (a.status IN ('pending', 'failed') OR (a.status = 'executed' AND l.lot_date >= ?::date))
          ORDER BY l.lot_date ASC, a.priority_rank ASC NULLS LAST, a.created_at ASC`, [tenantId, desde])).rows as FilaDePago[];
      const pagos = filas.length ? await this.armarFilas(trx, tenantId, filas, {
        conCfdi: (a) => !!a.authorized_at || a.status === 'executed' || LOCKED_LOT_STATUSES.has(a.lot_status ?? ''),
        validarDias: filas.filter((a) => a.status === 'executed' || !!a.authorized_at || LOCKED_LOT_STATUSES.has(a.lot_status ?? '')).map((a) => a.lot_date),
      }) : [];
      return { pagos, pagados_desde: desde, generado: new Date().toISOString() };
    });
  }

  /**
   * `[PGP.158][PGP.163]` **El CFDI de las facturas de unos pagos**, con el cancelado que casa cuando no
   * hay uno vigente: de ahí salen los avisos fiscales del renglón (PUE fuera de su mes, factura
   * cancelada). La bandeja no lo trae para los pagos en planeación (cuesta ~330 ms, `[PGP.108]`), así
   * que la pantalla lo pide EN DIFERIDO, como la evidencia: la lista no lo espera. Sólo lectura.
   */
  async cfdiDePagos(allocationIds: readonly string[]): Promise<Record<string, CfdiDelRenglon>> {
    const tenantId = this.tenantCtx.requireTenantId();
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = [...new Set(allocationIds.map((s) => String(s).trim()).filter((s) => UUID.test(s)))].slice(0, 300);
    if (!ids.length) return {};
    return this.tk.run(async (trx) => {
      const items = (await trx('finance.payment_allocation_items').where({ tenant_id: tenantId }).whereIn('allocation_id', ids)
        .whereIn('obligation_source', ['kepler_payable', 'supplier_payable']).select('id')) as { id: string }[];
      return Object.fromEntries(await leerCfdiConCancelados(trx, tenantId, items.map((i) => String(i.id))));
    });
  }

  /**
   * Los renglones de pagos con todo lo que la pantalla dice de cada uno: a quién (etiquetas de sus
   * facturas), cómo sale, qué hizo Kepler, la prueba del banco, el CFDI, la póliza y la cuenta de gasto.
   * `[PGP.113]` Salió de `listDayAllocations` para servir también a la bandeja de varios días.
   */
  private async armarFilas(trx: Knex.Transaction, tenantId: string, allocations: FilaDePago[], opts: {
    conCfdi: (a: FilaDePago) => boolean; validarDias: string[];
  }) {
    {
      const items = await trx('finance.payment_allocation_items').whereIn('allocation_id', allocations.map((a: any) => a.id));
      const bySource: Record<string, string[]> = {};
      for (const it of items as any[]) (bySource[it.obligation_source] ??= []).push(it.obligation_id);
      const labels = new Map<string, {
        beneficiary: string; concept: string; supplier_id?: string; branch_code?: string | null;
        /** `[PGP.58]` La llave de la ficha y de la evidencia, y la referencia que tecleó quien capturó. */
        entity_ref?: string | null; doc_ref?: string | null;
        /** `[PGP.120]` El acreedor en Kepler (sólo facturas derivadas vivas). */
        payee_code?: string | null;
        // `[PGP.36]` Sólo el origen derivado los trae: los otros no tienen factura del ERP detrás.
        vence?: string | null;
        /** `[PGP.40]` La etiqueta vino del universo completo: el ERP ya no debe esa factura. */
        saldada?: boolean;
        pronto_fecha_limite?: string | null; pronto_tasa?: number | null;
        pronto_beneficio?: number | null; pronto_estado?: string | null;
        /** `[PGP.126]` Es el pago de un anticipo pedido en la Suite (`[PGP.119]`): no admite descuento. */
        es_anticipo?: boolean;
        /** `[PGP.147]` Lo que la factura debe hoy en Kepler (sólo las vivas de `v_supplier_payables`). */
        kepler_debe?: number | null;
      }>();
      for (const source of Object.keys(bySource) as ObligationSource[]) {
        const ids = bySource[source];
        if (source === 'supplier_payable') {
          const rows = await trx('commercial.supplier_payment_obligations as o')
            .join('catalog.suppliers as s', 's.id', 'o.supplier_id')
            // `[PGP.197]` Si Kepler ya saldó su factura, el renglón lo dice igual que con una derivada (`[PGP.35]`).
            .joinRaw(`LEFT JOIN LATERAL (${sqlDebeKeplerDeCapturada('o')}) kd ON true`)
            .whereIn('o.id', ids)
            // `[PGP.126]` `to_jsonb(o) ->> 'nature'` en vez de `o.nature`: si el código llegara antes
            // que la migración `pgp119`, el día entero no se cae por una columna que aún no existe.
            .select('o.id', 's.name as beneficiary', 'o.supplier_id', trx.raw("nullif(btrim(o.kepler_sucursal), '') as branch_code"), trx.raw("coalesce(o.concept, o.invoice_folio, 'Mercancía') as concept"), trx.raw("to_jsonb(o) ->> 'nature' as nature"), trx.raw('kd.debe AS kepler_debe'));
          for (const r of rows as { id: string; beneficiary: string; concept: string; supplier_id: string; branch_code: string | null; nature: string | null; kepler_debe: number | string | null }[]) {
            const debe = r.kepler_debe === null || r.kepler_debe === undefined ? null : Number(r.kepler_debe);
            labels.set(`${source}:${r.id}`, {
              beneficiary: r.beneficiary, concept: r.concept, supplier_id: r.supplier_id, branch_code: r.branch_code ?? null, es_anticipo: r.nature === 'anticipo',
              // Sólo la saldada por completo: el «debe menos» de una capturada no tiene botón que lo baje (`[PGP.148]` ajusta derivadas).
              saldada: debe !== null && debe <= SALDADA_EN_KEPLER,
            });
          }
        } else if (source === 'kepler_payable') {
          // `[TP.18]` El derivado no tiene tabla: su etiqueta se rearma desde la vista por la
          // misma llave determinística con que se guardó el item (ADR-094 §4).
          // `[PGP.36]` **La ventana de pronto pago viaja con la etiqueta.** Es la MISMA consulta
          // que ya rearmaba el beneficiario: un `leftJoin` más y cuatro columnas, cero viajes
          // nuevos. La regla no se copia —`sqlVentanaProntoPago` es la de
          // `pronto-pago-ventana.contract.ts`— porque una segunda definición de «hasta cuándo
          // conviene pagar» diría otra fecha de la misma factura, y esto decide dinero.
          //
          // ⭐ Por qué acá y no sólo en la lista de «agregar facturas»: medido contra prod el
          // 2026-10-29, **$2,427,564 de descuento está en juego sobre la deuda viva** y el
          // renglón del día —donde se decide a quién se le paga hoy— no lo decía.
          const rows = await trx('analytics.v_supplier_payables as v')
            .leftJoin('catalog.suppliers as s', 's.code', 'v.proveedor')
            .leftJoin('analytics.mv_supplier_prompt_discount as d', trx.raw('btrim(d.proveedor_code) = btrim(v.proveedor)'))
            .whereRaw(`${KEPLER_PAYABLE_ID} = ANY(?::uuid[])`, [ids])
            .select(
              trx.raw(`${KEPLER_PAYABLE_ID} AS id`),
              trx.raw(`coalesce(s.name, v.proveedor_nombre, v.proveedor) AS beneficiary`),
              trx.raw(`coalesce(nullif(btrim(v.folio), ''), 'Factura') AS concept`),
              's.id AS supplier_id', 'v.sucursal AS branch_code',
              trx.raw('v.vencimiento AS vence'),
              trx.raw(sqlVentanaProntoPago('v', 'd')),
              /**
               * `[PGP.58]` **Desde el pago se tiene que poder ABRIR la factura** (Edgar, 2026-11-04:
               * «¿puedo ver la factura en PDF o imagen? ¿el folio interno para ubicarla?»). La
               * lista de deuda ya lo hacía; el desglose de un pago del día —donde se revisa antes
               * de pagar o autorizar— sólo decía sucursal, folio e importe. Medido ese día sobre
               * las 184 facturas vivas de los pagos pendientes: **121 con archivo, 44 sólo con UUID,
               * 18 sin nada**, y ninguna se podía abrir desde el pago. El `entity_ref` es la MISMA
               * llave natural que usan la ficha y `v_payable_evidence` (ver la pata `legKepler`).
               */
              trx.raw(`'oblig:' || v.sucursal || '|' || v.doc_tipo || '|' || v.doc_sub || '|' || btrim(v.folio) AS entity_ref`),
              trx.raw(`nullif(btrim(v.referencia), '') AS doc_ref`),
              // `[PGP.120]` El acreedor en Kepler: con la sucursal, es la llave de sus anticipos sin aplicar.
              trx.raw('btrim(v.proveedor) AS payee_code'),
              // `[PGP.147]` Lo que debe HOY: el pago se armó con otro saldo y una nota de crédito pudo bajarlo.
              trx.raw('v.pendiente::float8 AS kepler_debe'),
            );
          for (const r of rows as VentanaRow[]) {
            labels.set(`${source}:${r.id}`, {
              beneficiary: r.beneficiary, concept: r.concept,
              supplier_id: r.supplier_id ?? undefined, branch_code: r.branch_code ?? null,
              entity_ref: r.entity_ref ?? null, doc_ref: r.doc_ref ?? null,
              payee_code: r.payee_code ?? null,
              kepler_debe: r.kepler_debe === null || r.kepler_debe === undefined ? null : Number(r.kepler_debe),
              vence: r.vence ?? null,
              pronto_fecha_limite: r.pronto_fecha_limite ?? null,
              pronto_tasa: r.pronto_tasa === null || r.pronto_tasa === undefined ? null : Number(r.pronto_tasa),
              pronto_beneficio: r.pronto_beneficio === null || r.pronto_beneficio === undefined ? null : Number(r.pronto_beneficio),
              pronto_estado: r.pronto_estado ?? 'sin_medir',
            });
          }
          /**
           * `[PGP.40]` **Una factura que el ERP ya no debe TAMBIÉN tiene nombre.**
           *
           * ⛔ `analytics.v_supplier_payables` filtra `pendiente > 0.005`, así que la etiqueta de
           * una factura saldada volvía vacía y el renglón pintaba «—» en el beneficiario y «Sin
           * sucursal». `[PGP.35]` lo declaró en el contrato y **no lo resolvió en la pantalla**:
           * el resultado es un pago que no dice **a quién se le paga**, que es lo primero que
           * alguien necesita leer.
           *
           * ⭐ El nombre nunca se perdió: medido contra prod el 2026-10-31, las **33 de 33**
           * líneas sin etiqueta lo tienen en `kepler_ods.kdxe` (la factura existe, con saldo 0),
           * en `kepler_ods.kdxd` (el nombre del acreedor) y hasta en nuestro `catalog.suppliers`.
           * Sólo hacía falta mirar el universo COMPLETO en vez de la deuda viva.
           *
           * Es una consulta más y **sólo cuando hay huérfanas**: el día sano no la paga.
           */
          const faltan = ids.filter((id) => !labels.has(`${source}:${id}`));
          if (faltan.length) {
            const rescate = await trx
              .select(
                trx.raw(`md5('kepler_payable|'||k.sucursal||'|'||k.c4||'|'||k.c5||'|'||btrim(k.c6))::uuid AS id`),
                trx.raw(`coalesce(s.name, d.c3, btrim(k.c2)) AS beneficiary`),
                trx.raw(`coalesce(nullif(btrim(k.c6), ''), 'Factura') AS concept`),
                trx.raw(`s.id AS supplier_id`),
                trx.raw(`k.sucursal AS branch_code`),
                // `[PGP.58]` Saldada o no, el documento existe y su papel también.
                trx.raw(`'oblig:' || k.sucursal || '|' || k.c4 || '|' || k.c5 || '|' || btrim(k.c6) AS entity_ref`),
                trx.raw(`nullif(btrim(k.c16), '') AS doc_ref`),
              )
              .from(trx.raw(`kepler_ods.kdxe k`))
              .joinRaw(`LEFT JOIN LATERAL (SELECT c3 FROM kepler_ods.kdxd WHERE btrim(c2) = btrim(k.c2) LIMIT 1) d ON true`)
              .joinRaw(`LEFT JOIN catalog.suppliers s ON btrim(s.code) = btrim(k.c2)`)
              .whereRaw(`btrim(k.c1) = k.sucursal AND k.c3 = 'A'`)
              .whereRaw(`md5('kepler_payable|'||k.sucursal||'|'||k.c4||'|'||k.c5||'|'||btrim(k.c6))::uuid = ANY(?::uuid[])`, [faltan]);
            for (const r of rescate as { id: string; beneficiary: string; concept: string; supplier_id: string | null; branch_code: string | null; entity_ref: string | null; doc_ref: string | null }[]) {
              // ⛔ Se rescatan SÓLO el nombre, el folio y la sucursal. La ventana de pronto pago
              // NO: una factura saldada no tiene descuento que capturar, y publicarlo la pondría
              // a competir por atención con el aviso de que no se puede pagar.
              labels.set(`${source}:${r.id}`, {
                beneficiary: r.beneficiary, concept: r.concept,
                supplier_id: r.supplier_id ?? undefined, branch_code: r.branch_code ?? null,
                entity_ref: r.entity_ref ?? null, doc_ref: r.doc_ref ?? null,
                saldada: true,
              });
            }
          }
        } else {
          const rows = await trx(TABLE_BY_SOURCE[source] as string).whereIn('id', ids).select('id', 'beneficiary', 'concept');
          for (const r of rows as any[]) labels.set(`${source}:${r.id}`, { beneficiary: r.beneficiary, concept: r.concept ?? '—' });
        }
      }
      const itemsByAllocation = new Map<string, any[]>();
      // `[PGP.190]` En un pago PENDIENTE, cada factura de Kepler se compara contra SU parte del saldo: lo que cubren los
      // renglones vivos anteriores de la misma factura (partida entre transferencias) ya está tomado.
      const pendientes = new Set(allocations.filter((a) => a.status === 'pending').map((a) => String(a.id)));
      const antesDe = await this.cubiertoAntesDe(trx, tenantId, (items as { obligation_source: string; allocation_id: string; obligation_id: string }[])
        .filter((it) => it.obligation_source === 'kepler_payable' && pendientes.has(String(it.allocation_id))).map((it) => String(it.obligation_id)));
      const partidaDe = new Set<string>();
      for (const it of items as any[]) {
        const label = labels.get(`${it.obligation_source}:${it.obligation_id}`);
        // `[PGP.35]` **Una etiqueta vacía de origen derivado NO es un beneficiario desconocido:
        // es que Kepler ya no debe esa factura.** La etiqueta se rearma desde
        // `analytics.v_supplier_payables`, que filtra `pendiente > 0.005`; si el documento no
        // aparece, el ERP lo tiene saldado (pagado por fuera, o con nota de crédito). Hasta hoy
        // eso se pintaba «—» y el pago seguía sumando al total del día como deuda viva.
        //
        // ⛔ Medido contra prod el 2026-10-29: **27 de las 54 líneas derivadas** de los pagos
        // vivos están así — **11 de 27 pagos, $2,506,811.31 de $6,683,082.26**. Se descartó que
        // fuera deriva de la llave: las 27 existen en `kepler_ods.kdxe` con saldo 0 (si no
        // existieran, el defecto sería NUESTRO; ver kepler-payable-key.contract.ts:22).
        //
        // ⭐ Y es exactamente el síntoma que ese contrato anticipa —«una etiqueta en blanco y un
        // saldo que no baja»—, con el dato ya en la mano y tirándose. No cuesta una consulta más.
        // `execute()` ya lo rechaza (:1346-1352), pero ahí llega una persona después de preparar,
        // autorizar y firmar: decirlo acá es decirlo ANTES de gastar el día.
        // `[PGP.40]` Ya no se deduce de la ausencia de etiqueta: desde el rescate la etiqueta
        // EXISTE y trae la marca. Se conserva el caso sin etiqueta por si una factura no
        // estuviera ni en el universo completo — ahí sí no hay de dónde sacar nada.
        const saldada = (it.obligation_source === 'kepler_payable' && (!label || label.saldada === true))
          // `[PGP.197]` La capturada, sólo si se midió contra Kepler (sin llave no se afirma nada).
          || (it.obligation_source === 'supplier_payable' && label?.saldada === true);
        const antes = pendientes.has(String(it.allocation_id)) ? antesDe.get(String(it.id)) ?? 0 : 0;
        if (antes > 0.005) partidaDe.add(String(it.id));
        const arr = itemsByAllocation.get(it.allocation_id) ?? [];
        arr.push({
          ...it,
          beneficiary: label?.beneficiary ?? '—',
          concept: label?.concept ?? '—',
          supplier_id: label?.supplier_id ?? null,
          branch_code: label?.branch_code ?? null,
          entity_ref: label?.entity_ref ?? null,
          doc_ref: label?.doc_ref ?? null,
          payee_code: label?.payee_code ?? null,
          es_anticipo: label?.es_anticipo === true,
          kepler_saldada: saldada,
          // `[PGP.147]` Lo que debe hoy (0 si está saldada; null si no es factura de Kepler). `[PGP.190]` Partida: su parte.
          kepler_debe: it.obligation_source === 'kepler_payable' ? (saldada ? 0 : debeParaEsteRenglon(label?.kepler_debe ?? null, antes)) : (saldada ? 0 : null),
          // `[PGP.36]` La razón por la que esta factura está en el día de hoy.
          vence: label?.vence ?? null,
          pronto_fecha_limite: label?.pronto_fecha_limite ?? null,
          pronto_tasa: label?.pronto_tasa ?? null,
          pronto_beneficio: label?.pronto_beneficio ?? null,
          // ⛔ El origen que NO tiene factura del ERP detrás no es «sin medir»: no aplica. Son
          // cosas distintas y mezclarlas haría que un gasto recurrente pareciera un proveedor
          // del que no sabemos nada.
          pronto_estado: it.obligation_source === 'kepler_payable' ? (label?.pronto_estado ?? 'sin_medir') : null,
        });
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
      // `[PGP.94]` Lo que Kepler hizo con cada pago: folio, fecha, cuenta y comprobante. Una consulta
      // por día, sea cual sea su número de pagos.
      const cierres = await this.cierresKepler(
        trx,
        allocations.map((a) => ({ id: a.id, lotDate: a.lot_date, alta: toMxDateKey(a['created_at'] as Date | string | null) || a.lot_date })),
        items as { allocation_id: string; obligation_source: string; obligation_id: string }[],
      );
      // `[PGP.190]` «Transferencia k de n»: las partes vivas de cada pago partido, en el orden en que nacieron.
      const transferenciaDe = await this.transferenciasDe(trx, tenantId, allocations);
      // `[PGP.146]` Lo que dice la DESCARGA del banco de cada pendiente cuyo día ya llegó. Sólo lee (~45 ms
      // medido en prod el 2026-11-18); no marca pagado. Sin esto, un pago que ya salió se veía «por preparar».
      const hoyMx = todayMx();
      const descarga = allocations.some((a) => a.status === 'pending' && a.lot_date <= hoyMx)
        ? await this.segunLaDescarga(trx, tenantId, hoyMx) : new Map<string, SalidaSegunLaDescarga>();
      // `[PGP.147]` La factura que hoy debe MENOS de lo que el pago le lleva (Mondelez, 13-nov: una nota de crédito de
      // $120,000 aplicada el 12 y el pago salió completo). Sólo pendientes; los abonos se leen sólo si hay alguna.
      const paraDebeMenos = new Map<string, FacturaParaDebeMenos[]>();
      for (const a of allocations) {
        if (a.status !== 'pending') continue;
        const fs = (itemsByAllocation.get(a.id) ?? []).map((it) => ({
          id: String(it['id']), applied_amount: Number(it['applied_amount']), kepler_debe: (it['kepler_debe'] ?? null) as number | null,
          kepler_saldada: it['kepler_saldada'] === true, entity_ref: (it['entity_ref'] ?? null) as string | null, payee_code: (it['payee_code'] ?? null) as string | null,
          partida: partidaDe.has(String(it['id'])),
        }));
        if (facturasQueDebenMenos(fs).length) paraDebeMenos.set(a.id, fs);
      }
      const abonosDebeMenos = paraDebeMenos.size ? await this.abonosDeLasFacturas(trx, [...paraDebeMenos.values()].flat()) : new Map<string, AbonoQueBajoElSaldo[]>();
      // `[PGP.104]` Lo que prueba que se pagó: la salida del estado de cuenta + su comprobante (F2).
      // Sólo en un día que ya llegó; uno por venir no se ha pagado. `[PGP.113]` Uno por cada día pedido.
      // `[PGP.151]` Todos los días pedidos con UNA lectura (antes, cuatro consultas por día: ~1.3 s en la bandeja).
      const validaciones = await leerValidacionDeLosDias(trx, tenantId, opts.validarDias, todayMx());
      // `[PGP.108]` El CFDI de cada factura y si es PUE o PPD: decide la póliza de egreso de ContPAQi.
      // Sólo en un día autorizado o que ya llegó (los que van a tener póliza): cuesta ~330 ms y un día
      // en planeación no lo necesita.
      // `[PGP.113]` Por pago: quien llama dice cuáles (el día, todos si ya llegó; la bandeja, los autorizados y pagados).
      const conCfdi = new Set(allocations.filter((a) => opts.conCfdi(a)).map((a) => a.id));
      const facturasConCfdi = (items as { id: string; allocation_id: string; obligation_source: string }[])
        .filter((it) => conCfdi.has(it.allocation_id) && (it.obligation_source === 'kepler_payable' || it.obligation_source === 'supplier_payable')).map((it) => it.id);
      const cfdis = facturasConCfdi.length ? await leerCfdiDeFacturas(trx, tenantId, facturasConCfdi) : new Map();
      // `[PGP.109]` La póliza de egreso de lo ya «Pagado»: PUE al pagar; PPD cuando llega el REP
      // (Contabilidad, 2026-11-10). Sólo se leen los REP de las facturas PPD ligadas de esos pagos.
      const pagados = new Set((allocations as { id: string; status: string }[]).filter((a) => a.status === 'executed').map((a) => a.id));
      const uuidsPpd = (items as { id: string; allocation_id: string }[])
        .filter((it) => pagados.has(it.allocation_id))
        .map((it) => cfdis.get(String(it.id)))
        .filter((c) => c?.estado === 'unico' && c.metodo === 'PPD' && c.cfdi)
        .map((c) => c!.cfdi!.uuid);
      const repsDia = pagados.size ? await leerRepsDeFacturas(trx, uuidsPpd) : { reps: [], sincronizado_hasta: null };
      // `[PGP.111b]` La cuenta de gasto (52) de cada pago de GASTO: la que Contabilidad ya usó con ese RFC (P3).
      const rfcDePago = new Map<string, string | null>();
      for (const a of allocations as { id: string; classification: string }[]) {
        if (a.classification !== 'gasto' || !conCfdi.has(a.id)) continue;
        const rfc = (items as { id: string; allocation_id: string }[]).filter((it) => it.allocation_id === a.id)
          .map((it) => cfdis.get(String(it.id))?.rfc).find((r) => !!r) ?? null;
        rfcDePago.set(a.id, rfc);
      }
      const cuentasGasto = rfcDePago.size
        ? await leerCuentasGasto(trx, tenantId, [...rfcDePago.values()].filter((r): r is string => !!r))
        : new Map();
      const cuentaGastoDe = (id: string) => {
        if (!rfcDePago.has(id)) return null;
        const rfc = rfcDePago.get(id);
        return rfc ? cuentasGasto.get(rfc) ?? null : { estado: 'sin_rfc' as const, cuenta: null, nombre: null, veces: 0, total: 0, rfc: null };
      };
      return allocations.map((a) => {
        // `[PGP.91]` `numeric` llega como texto del driver: el descuento sale como número, y la
        // tasa como número o null (null = se capturó en pesos, no hay tasa que decir).
        const its = (itemsByAllocation.get(a.id) ?? []).map((it) => ({
          ...it, applied_amount: Number(it.applied_amount),
          discount_amount: Number(it.discount_amount ?? 0),
          discount_reason: (it.discount_reason ?? null) as DiscountReason | null,
          discount_rate: it.discount_rate === null || it.discount_rate === undefined ? null : Number(it.discount_rate),
          discount_note: (it.discount_note ?? null) as string | null,
          // `[PGP.101]` Los renglones del descuento; uno capturado antes de PGP.101 llega como UN renglón.
          discount_lines: lineasDeDescuento(it),
          cfdi: cfdis.get(String(it.id)) ?? null,
        }));
        // `[PGP.35]` El agregado por pago: cuántas de sus facturas quedaron saldadas en el ERP y
        // por cuánto. La pantalla lo necesita para no sumar como deuda viva lo que ya no se debe.
        const saldadas = its.filter((it) => it.kepler_saldada);
        // `[PGP.36]` **Lo que este pago captura y lo que deja pasar.** Es la cuenta de resultados
        // del renglón: sin ella el día publica un total y nadie puede juzgar si estuvo bien armado.
        // ⛔ `fuera_de_ventana` NO es «perdido» (el contrato lo dice): se pasó la mediana de lo que
        // históricamente funcionó y todavía se puede intentar. Por eso «deja pasar», no «pierde».
        // `[PGP.91]` La factura que YA lleva su pronto pago capturado no se estima otra vez: decía
        // «Gana $X» (o «Deja pasar $X») encima de «Descuento al pagar −$X» — el mismo dinero dos veces.
        // `[PGP.101]` Con varios descuentos, el pronto pago puede no ser el mayor: se busca en sus renglones.
        const estimable = its.filter((it) => !it.discount_lines.some((l) => l.reason === 'pronto_pago'));
        const captura = estimable.reduce((s, it) => s + (
          (it.pronto_estado === 'capturable' || it.pronto_estado === 'por_vencer') ? Number(it.pronto_beneficio || 0) : 0), 0);
        const dejaPasar = estimable.reduce((s, it) => s + (
          it.pronto_estado === 'fuera_de_ventana' ? Number(it.pronto_beneficio || 0) : 0), 0);
        return {
          ...a, amount_assigned: Number(a.amount_assigned),
          bank_account_label: a.bank_account_id ? origin.get(a.bank_account_id) ?? null : null,
          bank_account_kind: a.bank_account_id ? originKind.get(a.bank_account_id) ?? null : null,
          kepler_saldadas: saldadas.length,
          kepler_saldadas_importe: saldadas.reduce((s, it) => s + Number(it.applied_amount), 0),
          pronto_captura: Math.round(captura * 100) / 100,
          pronto_deja_pasar: Math.round(dejaPasar * 100) / 100,
          // `[PGP.91]` Lo que el proveedor descontó al pagar. `amount_assigned` sigue siendo el neto.
          discount_total: round2(its.reduce((s, it) => s + it.discount_amount, 0)),
          kepler_cierre: cierres.get(a.id) ?? null,
          // `[PGP.113]` Autorizado por sí mismo, o porque su día se autorizó completo (regla vieja).
          autorizado: !!a.authorized_at || LOCKED_LOT_STATUSES.has(a.lot_status ?? ''),
          validacion: validaciones.get(a.id) ?? null,
          banco_descarga: a.status === 'pending' && a.lot_date <= hoyMx ? descarga.get(a.id) ?? null : null,
          debe_menos: paraDebeMenos.has(a.id) ? debeMenosDelPago(paraDebeMenos.get(a.id) ?? [], abonosDebeMenos) : null,
          transferencia: transferenciaDe.get(String(a.id)) ?? null,
          cuenta_gasto: cuentaGastoDe(a.id),
          poliza: a.status === 'executed' ? (() => {
            const pd = (a as { paid_bank_date?: Date | string | null }).paid_bank_date;
            const fecha = pd ? (pd instanceof Date ? pd.toISOString().slice(0, 10) : String(pd).slice(0, 10)) : a.lot_date;
            return polizaEgresoDelPago(
              its.map((it) => ({
                item_id: String(it.id), cfdi_uuid: it.cfdi?.estado === 'unico' ? it.cfdi.cfdi?.uuid ?? null : null,
                metodo: it.cfdi?.estado === 'unico' ? it.cfdi.metodo : null, aplicado: Number(it.applied_amount),
              })),
              repsDia.reps, fecha, repsDia.sincronizado_hasta !== null && repsDia.sincronizado_hasta >= fecha, cuentaGastoDe(a.id));
          })() : null,
          items: its,
        };
      });
    }
  }

  /**
   * `[PGP.47]` **El expediente de cada factura del día**, para que el papel que se firma diga
   * contra QUÉ documentos se paga y qué hay que ir a buscar al archivo.
   *
   * ⛔ Nace porque el preliminar imprimía **una fila por pago** y escondía el detalle: medido
   * contra prod el 2026-11-03, los 102 pagos vivos tapan **236 líneas de factura** (2.4 por pago,
   * hasta 9), y el día de hoy son **62 facturas en 26 pagos**. Quien autoriza firmaba un total
   * sin poder ver qué lo compone, y quien arma el expediente físico tenía que volver a la
   * pantalla documento por documento.
   *
   * Cobertura medida el mismo día sobre las 226 líneas derivadas vivas: folio/fecha/vencimiento/
   * importe **85.4 %** (el 14.6 % que falta son las 33 que el ERP **ya tiene saldadas**),
   * referencia capturada 83.6 %, RFC 81.9 %, **PDF de la factura 62.8 %**, sólo UUID fiscal
   * 15.9 %, **sin ningún papel 21.2 %**.
   *
   * ⛔⛔ Dos trampas medidas, y por eso los campos se llaman como se llaman:
   *
   *  - **`referencia` NO es el folio de la factura del proveedor.** Es `kdxe.c16`, captura a
   *    mano. Control contra `fiscal.cfdis` anclando por RFC + importe ±$1: de 219 pares coincide
   *    el folio exacto en **4** y por dígitos en **11**, con placebo (el folio interno de Kepler)
   *    en **0**. `GE002` teclea `29955` y el CFDI es `S29955`; De La Rosa teclea `40-3115` contra
   *    un CFDI `F953520` —su remisión—; y hay `40 S/N`. Se publica como lo que es.
   *  - **`ref_evidencia` son DOS cosas con la misma forma.** 142 líneas traen el id interno del
   *    comprobante de recepción y 36 el **UUID fiscal del CFDI**, los dos de 36 caracteres.
   *    Por eso `uuid_fiscal` se llena **sólo** cuando la evidencia es `uuid`: publicar el otro
   *    como identificador fiscal mentiría en 142 de 178 casos.
   */
  async detalleExpediente(date: string): Promise<ExpedienteLinea[]> {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
      if (!lot) return [];

      // `[PGP.153]` La evidencia SÓLO de las facturas de este día (la función por llaves): antes el desglose cruzaba la
      // vista completa, ~3.7 s de los ~5.9 s del Preliminar. Las llaves salen de la misma vista de saldos que el desglose.
      const ev = await this.fuenteEvidencia(trx, trx.raw(
        `ARRAY(SELECT v2.sucursal || '|' || v2.doc_tipo || '|' || v2.doc_sub || '|' || btrim(v2.folio)
                 FROM finance.payment_allocation_items i2
                 JOIN finance.payment_allocations a2 ON a2.id = i2.allocation_id
                 JOIN analytics.v_supplier_payables v2 ON ${sqlKeplerPayableId('v2')} = i2.obligation_id
                WHERE a2.lot_id = ? AND a2.status <> 'cancelled' AND i2.obligation_source = 'kepler_payable')`, [lot.id]));
      // La deuda derivada del ERP: la vista de pagables trae el documento, y la de evidencia
      // (`[PGP.19]`) dice si su papel está digitalizado. Las dos por la MISMA llave natural.
      const derivadas = await trx('finance.payment_allocation_items as i')
        .join('finance.payment_allocations as a', 'a.id', 'i.allocation_id')
        .leftJoin('analytics.v_supplier_payables as v', trx.raw(`${KEPLER_PAYABLE_ID} = i.obligation_id`))
        .joinRaw(`LEFT JOIN ${ev.sql} e
                    ON e.sucursal = v.sucursal AND e.doc_tipo = v.doc_tipo
                   AND e.doc_sub = v.doc_sub AND btrim(e.folio) = btrim(v.folio)`, ev.binds as unknown as Knex.Value[])
        // El FOLIO EXTERNO —el que viene impreso en el papel del proveedor— no está en el ERP:
        // sale del comprobante de recepción (lo leyó el OCR) o del CFDI timbrado. Son las dos
        // únicas fuentes medidas, y cada una se declara por su nombre en `folio_externo_fuente`.
        .joinRaw(`LEFT JOIN finance.goods_receipt_proofs p
                    ON e.evidencia = 'pdf' AND p.id::text = e.ref_evidencia`)
        .joinRaw(`LEFT JOIN fiscal.cfdis c
                    ON e.evidencia = 'uuid' AND upper(c.uuid::text) = upper(e.ref_evidencia)`)
        .where('a.lot_id', lot.id).whereNot('a.status', 'cancelled')
        .where('i.obligation_source', 'kepler_payable')
        .select(
          'i.allocation_id', 'i.obligation_source', 'i.obligation_id', 'i.applied_amount', 'i.discount_amount',
          'v.sucursal', 'v.folio as documento', 'v.fecha', 'v.vencimiento',
          'v.importe', 'v.pendiente', 'v.referencia',
          'e.evidencia', 'e.ref_evidencia', 'e.rfc', 'e.rfc_fuente', 'e.rfc_discrepa',
          // ⛔ `p.folio_interno` NO se usa: medido el 2026-11-03, está en 2 de 142 comprobantes y
          // en **0** verificados (`folio_interno_ok`). El folio interno es el del ERP, y el
          // comprobante lo confirma por otro lado: `p.folio` coincide con `v.folio` en 142 de 142.
          // ⛔ Serie y folio son columnas DISTINTAS y pegarlas sin separador produce un folio que
          // no existe: `SD06` + `0092661394` salia `SD060092661394`, y en la factura dice
          // «Serie SD06 Folio 0092661394». Lo encontro Edgar leyendo el papel. 37 de 44 CFDI de
          // la deuda programada traen serie, asi que no es un caso de borde.
          trx.raw(`CASE WHEN nullif(btrim(c.folio), '') IS NULL THEN NULL
                        WHEN nullif(btrim(c.serie), '') IS NULL THEN btrim(c.folio)
                        ELSE btrim(c.serie) || '-' || btrim(c.folio) END AS folio_cfdi`),
          // ⭐ Todo lo que el CFDI tenga, MANDA sobre el ERP (Edgar, 2026-11-03). Medido sobre las
          // 43 líneas con CFDI identificado: la fecha difiere en **39 (91 %)**, hasta 179 días,
          // porque `kdxe.c7` es cuándo se REGISTRÓ la cuenta por pagar y `cfdis.fecha` es cuándo
          // se EMITIÓ la factura — y la que está impresa en el papel que se archiva es la segunda.
          // El RFC del emisor coincide con el de la vista en 41 de 43, pero 38 los había resuelto
          // por NOMBRE: tomarlo del comprobante timbrado lo vuelve verificable.
          // ⛔ El importe NO se reemplaza: el que decide cuánto se paga es el del ERP, que es
          // contra lo que se debe. Se trae sólo para DECLARAR cuando el CFDI dice otra cosa
          // (11 de 43), que es un hallazgo y no una corrección automática.
          trx.raw(`c.fecha::date AS fecha_cfdi`),
          trx.raw(`nullif(btrim(c.emisor_rfc), '') AS rfc_cfdi`),
          trx.raw(`c.total AS importe_cfdi`),
          trx.raw(`nullif(btrim(p.ocr_folio), '') AS folio_ocr`),
          trx.raw(`nullif(btrim(p.oc_folio), '') AS orden_compra`),
          'p.receipt_date as fecha_recepcion',
        );

      // Las obligaciones propias (HITL): no salen del ERP, así que ni evidencia ni RFC tienen —
      // y eso se DECLARA, no se dibuja como «sin papel» junto a las que sí deberían tenerlo.
      const propias = await trx('finance.payment_allocation_items as i')
        .join('finance.payment_allocations as a', 'a.id', 'i.allocation_id')
        .join('commercial.supplier_payment_obligations as o', 'o.id', 'i.obligation_id')
        .where('a.lot_id', lot.id).whereNot('a.status', 'cancelled')
        .where('i.obligation_source', 'supplier_payable')
        .select(
          'i.allocation_id', 'i.obligation_source', 'i.obligation_id', 'i.applied_amount', 'i.discount_amount',
          trx.raw("nullif(btrim(o.kepler_sucursal), '') as sucursal"),
          trx.raw('coalesce(o.invoice_folio, o.kepler_folio) as documento'),
          trx.raw('NULL::date as fecha'), 'o.original_due_date as vencimiento',
          'o.original_amount as importe',
          trx.raw('(o.original_amount - coalesce(o.paid_amount, 0)) as pendiente'),
          trx.raw('o.concept as referencia'),
        );

      const linea = (r: Record<string, unknown>, propia: boolean): ExpedienteLinea => {
        const ev = propia ? null : (r['evidencia'] as string | null);
        const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
        const dia = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString().slice(0, 10) : v).slice(0, 10) : null);
        // ⭐ El CFDI primero: es el folio TIMBRADO, no una lectura. El OCR acierta mucho (132 de
        // 142) pero es una lectura automática de una foto, y quien archiva tiene que saber cuál
        // de las dos está leyendo antes de darle crédito (ADR-056).
        const folioCfdi = (r['folio_cfdi'] as string | null) ?? null;
        const folioOcr = folioExternoLegible(r['folio_ocr'] as string | null);
        // La tercera fuente: lo que tecleó quien capturó la factura en el ERP. Es la más débil
        // de las tres y por eso va última, pero llena el hueco que dejan las otras dos.
        const folioErp = propia ? null : folioExternoLegible(r['referencia'] as string | null);
        return {
          allocation_id: String(r['allocation_id']),
          obligation_source: r['obligation_source'] as ObligationSource,
          obligation_id: String(r['obligation_id']),
          se_paga: Number(r['applied_amount']),
          descuento: Number(r['discount_amount'] ?? 0),
          sucursal: (r['sucursal'] as string | null) ?? null,
          folio_interno: (r['documento'] as string | null) ?? null,
          folio_externo: propia ? null : (folioCfdi ?? folioOcr ?? folioErp),
          folio_externo_fuente: propia ? null
            : folioCfdi ? 'cfdi' : folioOcr ? 'ocr' : folioErp ? 'erp' : 'ninguna',
          orden_compra: propia ? null : ((r['orden_compra'] as string | null) ?? null),
          fecha_recepcion: propia ? null : dia(r['fecha_recepcion']),
          // ⭐ El CFDI manda. `kdxe.c7` es cuándo se registró la cuenta por pagar; la fecha del
          // comprobante timbrado es cuándo se emitió la factura, que es la que está impresa en
          // el papel. Difieren en 39 de 43 líneas identificadas (hasta 179 días).
          fecha: (propia ? null : dia(r['fecha_cfdi'])) ?? dia(r['fecha']),
          fecha_fuente: propia ? null : (dia(r['fecha_cfdi']) ? 'cfdi' : dia(r['fecha']) ? 'erp' : 'ninguna'),
          vencimiento: dia(r['vencimiento']),
          // ⛔ Se DECLARA, no se corrige: el importe que decide cuánto se paga sigue siendo el del
          // ERP. Esto sólo expone que el comprobante dice otra cosa (11 de 43 líneas).
          importe_cfdi: propia ? null : num(r['importe_cfdi']),
          importe: num(r['importe']), pendiente: num(r['pendiente']),
          referencia: (r['referencia'] as string | null) ?? null,
          // ⭐ El emisor del comprobante timbrado gana sobre lo que el ERP tenga capturado o sobre
          // un cruce por nombre: coincide con el de la vista en 41 de 43, pero 38 de esos 43 los
          // había resuelto POR NOMBRE — tomarlo del CFDI los vuelve verificables.
          rfc: propia ? null : ((r['rfc_cfdi'] as string | null) ?? (r['rfc'] as string | null) ?? null),
          rfc_fuente: propia ? null
            : r['rfc_cfdi'] ? 'cfdi' : ((r['rfc_fuente'] as ExpedienteLinea['rfc_fuente']) ?? null),
          rfc_discrepa: propia ? null : ((r['rfc_discrepa'] as string | null) ?? null),
          // ⛔ `no_aplica` NO es `ninguna`: una obligación propia no tiene factura del ERP detrás,
          // y contarla como «sin papel» inflaría lo que hay que ir a buscar al archivo (ADR-056).
          papel: propia ? 'no_aplica' : (ev === 'pdf' || ev === 'uuid' ? ev : 'ninguna'),
          uuid_fiscal: ev === 'uuid' ? ((r['ref_evidencia'] as string | null) ?? null) : null,
          // `[PGP.40]` La factura que la vista de deuda viva no devuelve es la que el ERP ya
          // saldó — no una llave rota. Es lo primero que alguien tiene que leer antes de firmar.
          saldada: !propia && !r['documento'],
        };
      };

      return [
        ...(derivadas as Record<string, unknown>[]).map((r) => linea(r, false)),
        ...(propias as Record<string, unknown>[]).map((r) => linea(r, true)),
      ];
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
    const tenantId = this.tenantCtx.requireTenantId();
    // `[PGP.151]` Los pagos de los siete días en UNA pasada (antes, un armado por día: 3.5–5.5 s por semana).
    const porDia = await this.tk.run((trx) => this.pagosDeLosDias(trx, tenantId, days));
    // En serie a propósito: 7 días × 2 lecturas en paralelo serían 14 transacciones a la vez
    // contra el pool de prod, por una pantalla.
    const out: PaymentCalendarWeek['days'] = [];
    for (const d of days) {
      const summary = await this.daySummary(d);
      const allocations = (porDia.get(d) ?? []) as unknown as PaymentCalendarAllocation[];
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
  /**
   * `[PGP.41]` **Qué hay que pagar.** Lee `analytics.v_pago_sugerido` tal cual: la regla vive
   * en la vista, no acá, para que cualquier superficie que la consulte diga lo mismo.
   *
   * ⛔ `analytics.*` no tiene RLS: el alcance lo da el filtro explícito de tenant, igual que
   * el resto de este servicio.
   */
  async quePagar(): Promise<unknown[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);
      try {
        // `[PGP.53]` La evidencia del descuento viaja con la propuesta: «conviene» sin decir con
        // cuántos pagos se midió es una orden sin porqué. Sale de la MISMA matvista que la vista
        // usa para calcular `gana` (190 filas, una por proveedor: el join no infla).
        const { rows } = await trx.raw(
          `SELECT s.proveedor_code, s.proveedor_nombre, s.facturas, s.importe::float8 AS importe,
                  s.gana::float8 AS gana, s.tasa::float8 AS tasa, s.cierra::text AS cierra,
                  s.dias_restantes, s.vence_la_mas_vieja::text AS vence_la_mas_vieja,
                  s.rendimiento::float8 AS rendimiento, s.cuenta_estado, s.se_puede_preparar_hoy,
                  d.n_observaciones AS pagos_con_descuento, d.dias_mediana AS dias_tipicos,
                  d.descuento_12m::float8 AS ganado_12m
             FROM analytics.v_pago_sugerido s
             LEFT JOIN analytics.mv_supplier_prompt_discount d ON btrim(d.proveedor_code) = btrim(s.proveedor_code)
            ORDER BY s.dias_restantes ASC, s.gana DESC`,
        );
        return rows;
      } catch (e: unknown) {
        /**
         * `[PGP.43]` **La vista todavía no está en esta base: se DICE, no se devuelve un 500.**
         *
         * Visto en pantalla el 2026-11-02: el panel mostraba *«Internal server error»* porque el
         * código de `[PGP.41]` llegó a un backend donde `analytics.v_pago_sugerido` no existía —
         * la migración va ANTES de soltar y acá no se había aplicado. Es el mismo orden que ya
         * costó el retiro de `[PGP.29]`.
         *
         * ⛔ **No se esconde el problema**: se traduce. Se atrapa ÚNICAMENTE `42P01`
         * (`undefined_table`) — cualquier otro error sigue subiendo tal cual, porque un fallo de
         * datos disfrazado de «todavía no disponible» sería peor que el 500. Y se registra en el
         * log con el nombre de la vista, que es lo que necesita quien lo va a arreglar.
         */
        const code = (e as { code?: string })?.code;
        if (code === '42P01') {
          this.logger.warn(
            'analytics.v_pago_sugerido no existe en esta base: falta aplicar su migracion ' +
            '(20261031140043_pgp41_que_hay_que_pagar_hoy). «Que conviene pagar» queda NO MEDIDO.',
          );
          throw new ServiceUnavailableException(
            'Todavía no está disponible en esta base: falta aplicar su migración. No es que no haya nada que convenga pagar.',
          );
        }
        throw e;
      }
    });
  }

  /**
   * `[PGP.48]` **Los días que ya pasaron con pagos pendientes.** La pantalla sólo mira la semana
   * abierta, y un pago pendiente aparta el saldo de sus facturas: si su día pasó sin pagarse, esas
   * facturas quedan fuera de la lista de deuda y de la propuesta, y nada lo decía. Medido el
   * 2026-11-03: 23 pagos, $5,696,319.13, en 5 días del 19 al 29-oct.
   */
  async pendientesAtrasados(): Promise<PagosAtrasadosDia[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT a.id, l.lot_date::text AS date, a.amount_assigned::float8 AS monto,
                to_char(a.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS alta
           FROM finance.payment_allocations a
           JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
          WHERE a.tenant_id = ? AND a.status = 'pending'
            AND l.lot_date < (now() AT TIME ZONE 'America/Mexico_City')::date
          ORDER BY l.lot_date`,
        [tenantId],
      );
      const pend = rows as { id: string; date: string; monto: number; alta: string }[];
      if (!pend.length) return [];
      /*
       * `[PGP.95]` **Un pago que Kepler ya saldó no está atrasado.** Medido el 2026-11-06: de los 71
       * pagos pendientes en días pasados, 30 ($6.05 M) ya estaban pagados en Kepler y el aviso los
       * contaba como «siguen en días que ya pasaron». Ahora `pagos`/`monto` son sólo los que de
       * verdad faltan; los saldados se dicen aparte (`conciliados`), no desaparecen.
       */
      const items = await trx('finance.payment_allocation_items').whereIn('allocation_id', pend.map((p) => p.id))
        .select('allocation_id', 'obligation_source', 'obligation_id');
      const cierres = await this.cierresKepler(trx, pend.map((p) => ({ id: p.id, lotDate: p.date, alta: p.alta })), items);
      // `[PGP.146]` Lo que la descarga del banco ya muestra salido tampoco «sigue» por pagar (auditoría del 2026-11-18:
      // el aviso contaba 65 y 20 ya habían salido, mientras la bandeja y el veredicto del día los separaban).
      const descarga = await this.segunLaDescarga(trx, tenantId, todayMx());
      const porDia = new Map<string, PagosAtrasadosDia>();
      for (const p of pend) {
        const d = porDia.get(p.date) ?? { date: p.date, pagos: 0, monto: 0, conciliados: 0, conciliados_monto: 0, salidos: 0, salidos_monto: 0 };
        if (cierreCompleto(cierres.get(p.id))) { d.conciliados += 1; d.conciliados_monto = round2(d.conciliados_monto + Number(p.monto)); }
        else if (descarga.get(p.id)?.estado === 'salio') { d.salidos = (d.salidos ?? 0) + 1; d.salidos_monto = round2((d.salidos_monto ?? 0) + Number(p.monto)); }
        else { d.pagos += 1; d.monto = round2(d.monto + Number(p.monto)); }
        porDia.set(p.date, d);
      }
      return [...porDia.values()];
    });
  }

  /**
   * `[PGP.117]` **El pago que nadie pagó se libera, y queda en la bitácora.** Edgar, 2026-11-12: «después de una
   * semana hay que quitar lo que no se haya pagado, pero dejar logs de lo ocurrido» (`[PGP.204]`: se bajó a un día y
   * se regresó a la semana el 2026-11-23, medido). `[PGP.48]` sólo avisaba de los pagos atrasados;
   * mientras seguían `pending`, sus facturas no se ofrecían para programar.
   *
   * La regla es `decidirVencido` (pura, con sus pruebas): se libera sólo si NINGÚN testigo dice que se
   * pagó (Kepler sin abono a ninguna de sus facturas y el banco sin una salida por ese importe). Aquí
   * sólo se lee y se escribe. Liberar = `status = 'cancelled'` + nota + una fila en
   * `finance.payment_allocation_history` con lo medido en ese momento; los renglones no se borran.
   *
   * ⛔ Todo en UNA transacción: si la bitácora no se puede escribir (su migración sin aplicar), no se
   * libera nada. Liberar sin dejar constancia es justo lo que se pidió que no pase. Y si el banco no
   * se puede leer, la pasada entera falla: tampoco se libera nada.
   *
   * Lo llama `PagosVencidosService` en el worker, con el primer aviso de Kepler de cada día, dentro
   * del scope del tenant. Re-correrlo el mismo día no hace nada nuevo: lo liberado ya no está pendiente.
   */
  async liberarVencidos(hoy: string = todayMx(), autor = AUTOR_PAGOS_VENCIDOS): Promise<ResultadoPagosVencidos> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const conservados: Record<MotivoConservar, number> = {
        ligado: 0, cheque_emitido: 0, kepler_sin_medir: 0, kepler_pagado: 0, kepler_en_parte: 0, banco: 0, banco_sin_medir: 0,
      };
      const out: ResultadoPagosVencidos = { hoy, revisados: 0, liberados: 0, monto_liberado: 0, ids_liberados: [], conservados };
      // `[PGP.149]` Primero se regresa lo que una pasada anterior soltó habiendo salido del banco.
      const regreso = await this.regresarLosQueSalieron(trx, tenantId, hoy, autor);
      out.regresados = regreso.ids.length;
      out.ids_regresados = regreso.ids;
      out.reprogramados_tras_liberar = regreso.reprogramados;
      const pend = (await trx.raw(SQL_PENDIENTES_VENCIDOS, [tenantId, hoy])).rows as FilaPendienteVencido[];
      out.revisados = pend.length;
      if (!pend.length) return out;
      const ids = pend.map((p) => p.id);
      const items = (await trx('finance.payment_allocation_items').whereIn('allocation_id', ids)
        .select('allocation_id', 'obligation_source', 'obligation_id', 'applied_amount', 'discount_amount')) as
        (ItemParaCierre & { applied_amount: string | number; discount_amount: string | number | null })[];
      const cierres = await this.cierresKepler(trx, pend.map((p) => ({ id: p.id, lotDate: p.lot_date, alta: p.alta })), items);
      // `[PGP.149]` El banco: el libro O la descarga; «no salió» sólo con la descarga cubriendo esos días.
      const salidas = (await trx.raw(SQL_SALIDA_DE_BANCO, paramsSalidaDeBanco(tenantId, hoy, pend)))
        .rows as { id: string; salio: boolean; cubierto: boolean }[];
      const banco = new Map(salidas.map((s) => [s.id, testigoDelBanco(s)]));

      for (const p of pend) {
        const cierre = cierres.get(p.id) ?? null;
        const d = decidirVencido({
          lotDate: p.lot_date, cierre, salidaDeBanco: banco.has(p.id) ? banco.get(p.id) ?? null : null, ligado: !!p.ligado,
          chequeEmitido: !!p.cheque_emitido, // `[PGP.173]`
        }, hoy);
        if (d.accion === 'esperar') continue;
        if (d.accion === 'conservar') { conservados[d.motivo]++; continue; }
        const nota = notaLiberado(hoy, d.dias);
        // Guarda de carrera: sólo si sigue pendiente en este instante (alguien pudo pagarlo o moverlo).
        const n = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: p.id, status: 'pending' }).update({
          status: 'cancelled', notes: `${p.notes ?? ''}\n${nota}`.trim(), updated_by: autor, updated_at: trx.fn.now(),
        });
        if (!n) continue;
        const renglones = items.filter((i) => i.allocation_id === p.id);
        await trx('finance.payment_allocation_history').insert({
          tenant_id: tenantId, allocation_id: p.id, event: EVENTO_LIBERADO, status_from: 'pending', status_to: 'cancelled',
          created_by: autor,
          detail: JSON.stringify({
            regla: 'PGP.117', hoy, dias: d.dias, nota,
            pago: {
              dia: p.lot_date, estado_del_dia: p.lot_status, alta: p.alta, monto: p.monto, clasificacion: p.classification,
              programo: p.created_by, autorizo: p.authorized_by,
            },
            renglones: renglones.map((r) => ({
              origen: r.obligation_source, obligacion: r.obligation_id,
              aplicado: Number(r.applied_amount), descuento: Number(r.discount_amount ?? 0),
            })),
            testigos: { kepler: cierre ? { estado: cierre.estado, facturas: cierre.facturas } : null, banco_mismo_importe: false },
          }),
        });
        for (const r of renglones) await this.recalcObligation(trx, r.obligation_source as ObligationSource, r.obligation_id);
        out.liberados++;
        out.monto_liberado = round2(out.monto_liberado + Number(p.monto));
        out.ids_liberados.push(p.id);
      }
      return out;
    });
  }

  /**
   * `[PGP.149]` **Lo que la liberación soltó habiendo salido del banco, vuelve.** El 17-nov se liberaron 7 pagos del
   * 10-nov que la descarga del banco muestra salidos ($1,893,556.02): el testigo leía sólo el libro, parado desde el
   * 10-nov. Kepler todavía debía sus facturas, así que se ofrecían otra vez para pagar. Aquí cada uno regresa a
   * `pending` (el estado que tenía antes del error), con su nota y una fila `reabierto_salio_del_banco` en la bitácora
   * con la salida que lo prueba; `[PGP.146]` lo pone entonces en «Por registrar en Kepler».
   * ⛔ Si sus facturas ya están en otro pago vivo (alguien las volvió a programar) NO se toca: dos pagos de las mismas
   * facturas es justo lo que esto evita; se cuenta aparte para que una persona lo revise.
   */
  private async regresarLosQueSalieron(trx: Knex.Transaction, tenantId: string, hoy: string, autor: string): Promise<{ ids: string[]; reprogramados: string[] }> {
    const filas = (await trx.raw(SQL_LIBERADOS_QUE_SALIERON, [tenantId])).rows as FilaLiberadoQueSalio[];
    const ids: string[] = [];
    const reprogramados: string[] = [];
    for (const f of filas) {
      if (f.reprogramado) { reprogramados.push(f.id); continue; }
      const nota = notaReabierto(hoy, { ...f, importe: Number(f.importe) });
      const n = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: f.id, status: 'cancelled' }).update({
        status: 'pending', notes: `${f.notes ?? ''}\n${nota}`.trim(), updated_by: autor, updated_at: trx.fn.now(),
      });
      if (!n) continue;
      await trx('finance.payment_allocation_history').insert({
        tenant_id: tenantId, allocation_id: f.id, event: EVENTO_REABIERTO, status_from: 'cancelled', status_to: 'pending', created_by: autor,
        detail: JSON.stringify({ regla: 'PGP.149', hoy, nota, liberado: f.liberado, dia: f.lot_date, monto: Number(f.monto),
          salida: { fecha: f.fecha, cuenta: f.cuenta, importe: Number(f.importe) } }),
      });
      const renglones = await trx('finance.payment_allocation_items').where({ allocation_id: f.id }).select('obligation_source', 'obligation_id');
      for (const r of renglones) await this.recalcObligation(trx, r.obligation_source as ObligationSource, r.obligation_id);
      ids.push(f.id);
    }
    return { ids, reprogramados };
  }

  /**
   * `[PGP.148]` **Ajustar el pago al saldo de Kepler** (un clic): cada factura de Kepler que hoy debe menos de lo que
   * el pago le lleva baja a lo que debe. Caso Mondelez: una nota de crédito de $120,000 aplicada el 12-nov y el pago
   * del 13 salió completo. Sólo en un pago pendiente, sin autorizar (D19 b) y que no haya salido ya del banco.
   */
  async ajustarAlSaldo(allocationId: string, username: string, hoy: string = todayMx()): Promise<PaymentCalendarAjusteAlSaldo> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => this.ajustarAlSaldoEn(trx, tenantId, allocationId, username, 'manual', hoy));
  }

  /**
   * `[PGP.148]` D19 (b): **el pago sin autorizar se ajusta solo** cuando Kepler baja el saldo de su factura. Lo llama el
   * worker con cada aviso de Kepler (`PagosVencidosService`, sin reloj). Sólo días POR VENIR (el de hoy o uno pasado
   * pudo ya salir del banco) y sólo si lo que bajó el saldo no es dinero (`seAjustaSolo`). Cada pago en su propio
   * punto de guardado: uno que falla no detiene a los demás. Escribe la bitácora de cada ajuste.
   */
  async ajustarLosQueDebenMenos(hoy: string = todayMx(), autor = AUTOR_AJUSTE_AL_SALDO): Promise<{ revisados: number; ajustados: string[]; monto: number; omitidas: number; fallidos: number }> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const filas = (await trx.raw(SQL_CANDIDATOS_AJUSTE, [tenantId, hoy])).rows as
        { id: string; dia: string; monto: number; item_id: string; obligation_id: string; applied_amount: number; discount_amount: number }[];
      const out = { revisados: new Set(filas.map((f) => f.id)).size, ajustados: [] as string[], monto: 0, omitidas: 0, fallidos: 0 };
      if (!filas.length) return out;
      const saldos = await this.saldosDeKepler(trx, filas.map((f) => f.obligation_id));
      // `[PGP.190]` La parte del saldo que le toca a cada renglón (la factura puede estar partida entre transferencias).
      const antesDe = await this.cubiertoAntesDe(trx, tenantId, filas.map((f) => f.obligation_id));
      const conDeMas = new Set(filas.filter((f) => {
        const s = saldos.get(f.obligation_id);
        const antes = antesDe.get(String(f.item_id)) ?? 0;
        return f.discount_amount <= 0 && !!s && facturasQueDebenMenos([{ id: f.item_id, applied_amount: f.applied_amount, kepler_debe: debeParaEsteRenglon(s.debe, antes),
          kepler_saldada: false, entity_ref: null, payee_code: null, partida: antes > 0.005 }]).length > 0;
      }).map((f) => f.id));
      for (const id of conDeMas) {
        try {
          const r = await trx.transaction((sp) => this.ajustarAlSaldoEn(sp, tenantId, id, autor, 'automatico', hoy));
          out.omitidas += r.omitidas.length;
          if (r.ajustadas.length) { out.ajustados.push(id); out.monto = round2(out.monto + r.antes - r.amount_assigned); }
        } catch (e: unknown) {
          out.fallidos++;
          this.logger.warn(`[PGP.148] no se ajustó el pago ${id}: ${(e as Error)?.message}`);
        }
      }
      return out;
    });
  }

  /**
   * `[PGP.190]` «Transferencia k de n» de cada pago partido: sus partes vivas (no canceladas) en el orden en que nacieron.
   * El grupo se lee de la fila (`a.*`): si el código llega antes que la migración `pgp190`, ninguna fila lo trae y no se
   * consulta nada — el día no se cae por una columna que aún no existe (mismo criterio que `[PGP.126]`).
   */
  private async transferenciasDe(trx: Knex.Transaction, tenantId: string, allocations: readonly { id: unknown; [k: string]: unknown }[]): Promise<Map<string, PaymentCalendarTransferenciaDe>> {
    const grupos = [...new Set(allocations.map((a) => a['split_from_id']).filter((g): g is string => typeof g === 'string' && !!g))];
    const out = new Map<string, PaymentCalendarTransferenciaDe>();
    if (!grupos.length) return out;
    const filas = (await trx.raw(
      `SELECT a.id::text AS id, a.split_from_id::text AS grupo
         FROM finance.payment_allocations a
        WHERE a.tenant_id = ? AND a.split_from_id = ANY(?::uuid[]) AND a.status <> 'cancelled'
        ORDER BY a.created_at, a.id`, [tenantId, grupos])).rows as { id: string; grupo: string }[];
    const porGrupo = new Map<string, string[]>();
    for (const f of filas) porGrupo.set(f.grupo, [...(porGrupo.get(f.grupo) ?? []), f.id]);
    for (const [grupo, ids] of porGrupo) {
      if (ids.length < 2) continue;
      ids.forEach((id, k) => out.set(id, { grupo, parte: k + 1, de: ids.length }));
    }
    return out;
  }

  /**
   * `[PGP.190]` Lo que cubren los renglones vivos ANTERIORES de la misma factura, por renglón (0 si la factura no está
   * partida). Con esto, «lo que debe» de cada renglón es su parte del saldo y no el saldo entero: una factura partida
   * entre dos transferencias no puede llevar, sumada, más de lo que Kepler dice que se debe.
   */
  private async cubiertoAntesDe(trx: Knex.Transaction, tenantId: string, obligationIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(obligationIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const filas = (await trx.raw(SQL_RENGLONES_VIVOS_DE_LAS_FACTURAS, [tenantId, ids])).rows as RenglonVivoDeLaFactura[];
    return cubiertoAntesPorRenglon(filas);
  }

  /** `[PGP.148]` El saldo de HOY de facturas de Kepler, por su llave de obligación (la misma consulta que la etiqueta). */
  private async saldosDeKepler(trx: Knex.Transaction, obligationIds: string[]): Promise<Map<string, { debe: number; entity_ref: string; payee_code: string | null }>> {
    const ids = [...new Set(obligationIds)];
    if (!ids.length) return new Map();
    const rows = (await trx('analytics.v_supplier_payables as v')
      .whereRaw(`${KEPLER_PAYABLE_ID} = ANY(?::uuid[])`, [ids])
      .select(
        trx.raw(`(${KEPLER_PAYABLE_ID})::text AS id`), trx.raw('v.pendiente::float8 AS debe'),
        trx.raw(`'oblig:' || v.sucursal || '|' || v.doc_tipo || '|' || v.doc_sub || '|' || btrim(v.folio) AS entity_ref`),
        trx.raw('btrim(v.proveedor) AS payee_code'),
      )) as { id: string; debe: number | string; entity_ref: string; payee_code: string | null }[];
    return new Map(rows.map((r) => [String(r.id), { debe: Number(r.debe), entity_ref: r.entity_ref, payee_code: r.payee_code }]));
  }

  /**
   * `[PGP.148]` El ajuste, dentro de una transacción. `automatico` = el worker y `reprogramar` = el pago que nace al
   * moverlo (`[PGP.184]`): los dos sólo ajustan lo que `seAjustaSolo` permite; `manual` es la persona con «Bajar a».
   */
  private async ajustarAlSaldoEn(
    trx: Knex.Transaction, tenantId: string, allocationId: string, username: string, modo: ModoAjusteAlSaldo, hoy: string,
    opciones: OpcionesAjusteAlSaldo = {},
  ): Promise<PaymentCalendarAjusteAlSaldo> {
    const a = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).forUpdate().first();
    if (!a) throw new NotFoundException('Pago no encontrado');
    if (a.status !== 'pending') throw new BadRequestException('Sólo se ajusta un pago pendiente.');
    assertSinAutorizar(a);
    // El día como texto: un `date` leído como Date puede correrse un día por la zona del proceso.
    const lot = await trx('finance.payment_calendar_lots').where({ id: a.lot_id }).first('status', trx.raw("to_char(lot_date, 'YYYY-MM-DD') AS dia")) as { status: string; dia: string } | undefined;
    if (lot && LOCKED_LOT_STATUSES.has(lot.status)) throw new BadRequestException('El día ya fue autorizado: no se le puede cambiar el importe a sus pagos.');
    const dia = lot?.dia ?? hoy;
    const antes = Number(a.amount_assigned);
    const items = await trx('finance.payment_allocation_items').where({ tenant_id: tenantId, allocation_id: allocationId }).forUpdate()
      .select('id', 'obligation_source', 'obligation_id', 'applied_amount', 'discount_amount');
    const kp = items.filter((i) => i.obligation_source === 'kepler_payable');
    const saldos = await this.saldosDeKepler(trx, kp.map((i) => String(i.obligation_id)));
    // `[PGP.190]` Cada renglón contra SU parte del saldo: lo de los renglones vivos anteriores de la misma factura ya está tomado.
    const antesDe = await this.cubiertoAntesDe(trx, tenantId, kp.map((i) => String(i.obligation_id)));
    const facturas: FacturaParaDebeMenos[] = kp.map((i) => {
      const s = saldos.get(String(i.obligation_id));
      const antes = antesDe.get(String(i.id)) ?? 0;
      return { id: String(i.id), applied_amount: Number(i.applied_amount), kepler_debe: s ? debeParaEsteRenglon(s.debe, antes) : null, kepler_saldada: !s,
        entity_ref: s?.entity_ref ?? null, payee_code: s?.payee_code ?? null, partida: antes > 0.005 };
    });
    const malas = facturasQueDebenMenos(facturas);
    // `[PGP.184]` Sin nada de más no hay nada que mirar en el banco (cada reprogramación pasa por aquí).
    if (!malas.length) return { allocation_id: allocationId, antes, amount_assigned: antes, ajustadas: [], omitidas: [] };
    const nombre = (f: FacturaParaDebeMenos) => { const c = cargoDeLaFactura(f); return c ? `${c.tipo}-${c.sub}-${c.folio}` : (f.entity_ref ?? '—'); };
    // `[PGP.184]` Al reprogramar a hoy o a un día pasado, o si venía autorizado: sólo se dice (D19 b), no se escribe.
    if (opciones.soloAvisar) {
      return { allocation_id: allocationId, antes, amount_assigned: antes, ajustadas: [], omitidas: malas.map((f) => ({ item_id: f.id, factura: nombre(f), motivo: opciones.soloAvisar as string })) };
    }
    // ⛔ Lo que ya salió del banco por su importe no se ajusta: la salida se quedaría sin pago que la reclame. `[PGP.184]`
    // Al reprogramar se mira desde el día ORIGINAL: con el día nuevo (más adelante) la ventana quedaba vacía.
    const desde = opciones.diaBancoDesde && opciones.diaBancoDesde < dia ? opciones.diaBancoDesde : dia;
    const [{ salio }] = (await trx.raw(SQL_YA_SALIO_DEL_BANCO, [tenantId, antes, desde, hoy, tenantId, antes, desde, hoy])).rows as { salio: boolean }[];
    if (salio) {
      throw new BadRequestException('Este pago ya salió del banco por su importe: no se ajusta (lo pagado de más se recupera con el proveedor o se aplica a su siguiente factura en Kepler).');
    }
    const abonos = await this.abonosDeLasFacturas(trx, malas);
    // `[PGP.184]` «Desde que se armó» cuenta desde el pago ORIGINAL: el reprogramado es el mismo pago en otro día.
    const armadoEl = modo !== 'manual' ? await this.armadoOriginal(trx, allocationId, a.created_at) : toMxDateKey(a.created_at);
    const ajustadas: (PaymentCalendarAjusteAlSaldo['ajustadas'][number] & { abonos: AbonoQueBajoElSaldo[] })[] = [];
    const omitidas: PaymentCalendarAjusteAlSaldo['omitidas'] = [];
    for (const f of malas) {
      const it = kp.find((i) => String(i.id) === f.id)!;
      const c = cargoDeLaFactura(f);
      const factura = nombre(f);
      const ab = c ? abonos.get(c.llave) ?? [] : [];
      // `[PGP.190]` Un renglón no baja a cero (la base pide importe > 0): si las otras transferencias ya cubren la factura, se quita.
      if ((f.kepler_debe as number) <= 0.005) { omitidas.push({ item_id: f.id, factura, motivo: MOTIVO_CUBIERTA_POR_OTRA_PARTE }); continue; }
      if (Number(it.discount_amount ?? 0) > 0) { omitidas.push({ item_id: f.id, factura, motivo: 'lleva descuento al pagar: ajústala a mano' }); continue; }
      if (modo !== 'manual' && !seAjustaSolo(ab, armadoEl)) {
        omitidas.push({ item_id: f.id, factura, motivo: 'un pago en Kepler bajó su saldo (puede ser este mismo pago): lo decide una persona' });
        continue;
      }
      const despues = round2(f.kepler_debe as number);
      await trx('finance.payment_allocation_items').where({ id: f.id }).update({ applied_amount: despues });
      await this.recalcObligation(trx, it.obligation_source as ObligationSource, it.obligation_id);
      ajustadas.push({ item_id: f.id, factura, antes: f.applied_amount, despues, abonos: ab });
    }
    if (!ajustadas.length) return { allocation_id: allocationId, antes, amount_assigned: antes, ajustadas: [], omitidas };
    await this.recalcAllocationTotal(trx, allocationId);
    const [b] = await trx('finance.payment_allocations').where({ id: allocationId })
      .update({ updated_by: username, updated_at: trx.fn.now() }).returning(['amount_assigned']);
    const despues = Number(b.amount_assigned);
    await trx('finance.payment_allocation_history').insert({
      tenant_id: tenantId, allocation_id: allocationId, event: EVENTO_AJUSTADO_AL_SALDO, status_from: 'pending', status_to: 'pending', created_by: username,
      detail: JSON.stringify({ regla: 'PGP.148', modo, hoy, antes, despues, facturas: ajustadas, omitidas }),
    });
    return { allocation_id: allocationId, antes, amount_assigned: despues, ajustadas: ajustadas.map((x) => ({ item_id: x.item_id, factura: x.factura, antes: x.antes, despues: x.despues })), omitidas };
  }

  /** `[PGP.184]` El día (AAAA-MM-DD, México) en que se armó el pago original de la cadena de reprogramaciones. */
  private async armadoOriginal(trx: Knex.Transaction, allocationId: string, creadoEl: Date | string): Promise<string> {
    const [r] = (await trx.raw(SQL_ARMADO_ORIGINAL, [allocationId])).rows as { armado: string | null }[];
    return r?.armado || toMxDateKey(creadoEl);
  }

  /** `[PGP.147]` Los abonos vivos que Kepler aplicó a las facturas que deben menos, por llave de cargo. */
  private async abonosDeLasFacturas(trx: Knex.Transaction, facturas: FacturaParaDebeMenos[]): Promise<Map<string, AbonoQueBajoElSaldo[]>> {
    const cargos = [...new Map(facturasQueDebenMenos(facturas).map((f) => cargoDeLaFactura(f))
      .filter((c): c is CargoKepler => !!c).map((c) => [c.llave, c] as const)).values()];
    const out = new Map<string, AbonoQueBajoElSaldo[]>();
    if (!cargos.length) return out;
    const filas = (await trx.raw(SQL_ABONOS_DE_LAS_FACTURAS, [cargos.map((c) => c.sucursal), cargos.map((c) => c.acreedor),
      cargos.map((c) => c.tipo), cargos.map((c) => c.sub), cargos.map((c) => c.folio)])).rows as { llave: string; tipo: number; folio: string; fecha: string | null; monto: number }[];
    for (const r of filas) {
      const arr = out.get(r.llave) ?? [];
      arr.push({ doc: `${r.tipo}-${r.folio}`, clase: claseDeAbono(Number(r.tipo)), fecha: r.fecha, monto: Number(r.monto) });
      out.set(r.llave, arr);
    }
    return out;
  }

  /**
   * `[PGP.146]` Qué dice la DESCARGA del banco de los pendientes cuyo día ya llegó (`segunLaDescarga`, pura). Tres
   * lecturas dentro de la transacción de quien llama; no escribe nada.
   */
  private async segunLaDescarga(trx: Knex.Transaction, tenantId: string, hoy: string): Promise<Map<string, SalidaSegunLaDescarga>> {
    const reclamantes = (await trx.raw(SQL_RECLAMANTES_DE_LA_DESCARGA, [tenantId, hoy, hoy])).rows as ReclamanteDeLaDescarga[];
    if (!reclamantes.some((r) => r.status === 'pending')) return new Map();
    const salidas = (await trx.raw(SQL_SALIDAS_DE_LA_DESCARGA, [tenantId, hoy, hoy])).rows as SalidaBanco[];
    const cobertura = (await trx.raw(SQL_COBERTURA_DE_LA_DESCARGA, [tenantId])).rows as CoberturaDeLaDescarga[];
    return segunLaDescarga(reclamantes, salidas, cobertura, hoy);
  }

  /**
   * `[PGP.121]` **El banco dispara el pago** (Edgar, 2026-11-13). Un pago pendiente cuya salida aparece en el estado
   * de cuenta —por importe y fecha, en una sola cuenta, uno a uno (`decidirPagosPorElBanco`, pura, con sus pruebas)—
   * queda pagado con esa evidencia: la cuenta de origen es la del movimiento, el método `transferencia` si nadie lo
   * preparó. Sin autorizar ni marcar a mano. Cada uno queda en `finance.payment_allocation_history` con lo que se
   * planeó y lo que el banco dijo.
   *
   * ⛔ Un pago por transacción, con guarda de carrera: sigue pendiente y nadie más tomó esa salida. Lo que el banco
   * no decide (`sin_salida`, `varias_cuentas`, `disputada`, `excluido`) se cuenta y se dice; no se toca.
   * Lo llama `PagosPorElBancoService` en el worker, con cada carga del banco, dentro del scope del tenant.
   */
  async pagarPorElBanco(hoy: string = todayMx(), autor = AUTOR_PAGO_POR_EL_BANCO): Promise<ResultadoPagoPorElBanco> {
    const tenantId = this.tenantCtx.requireTenantId();
    const out: ResultadoPagoPorElBanco = {
      hoy, revisados: 0, pagados: 0, monto: 0, ids_pagados: [], sin_decidir: { sin_salida: 0, varias_cuentas: 0, disputada: 0, excluido: 0 },
    };
    const leido = await this.tk.run(async (trx) => {
      const pagos = (await trx.raw(SQL_PENDIENTES_POR_EL_BANCO, [tenantId, hoy, hoy])).rows as
        { id: string; dia: string; importe: number; metodo: string | null; cuenta_planeada: string | null }[];
      if (!pagos.length) return null;
      const desde = pagos.map((p) => p.dia).reduce((a, b) => (b < a ? b : a));
      const salidas = (await trx.raw(SQL_SALIDAS_POR_EL_BANCO, [tenantId, desde, hoy])).rows as SalidaBanco[];
      const ligadas = new Set(((await trx.raw(SQL_SALIDAS_LIGADAS, [tenantId])).rows as { id: string }[]).map((r) => r.id));
      return { pagos, decision: decidirPagosPorElBanco(pagos.map((p) => ({ ...p, importe: Number(p.importe) })),
        salidas.map((x) => ({ ...x, importe: Number(x.importe) })), hoy, ligadas) };
    });
    if (!leido) return out;
    out.revisados = leido.decision.size;
    for (const p of leido.pagos) {
      const d = leido.decision.get(p.id);
      if (!d) continue;
      if (d.estado !== 'probado') { out.sin_decidir[d.estado]++; continue; }
      const hecho = await this.tk.run(async (trx) => {
        const otra = await trx('finance.payment_allocations')
          .where({ tenant_id: tenantId, paid_bank_movement_id: d.movimiento_id }).whereNot({ id: p.id }).whereNot({ status: 'cancelled' }).first('id');
        if (otra) return false;
        const n = await trx('finance.payment_allocations')
          .where({ tenant_id: tenantId, id: p.id, status: 'pending' }).whereNull('paid_bank_movement_id')
          .update({
            status: 'executed', executed_at: trx.fn.now(), payment_method: trx.raw(`coalesce(payment_method, 'transferencia')`),
            bank_account_id: d.cuenta_id, paid_bank_movement_id: d.movimiento_id, paid_bank_date: d.fecha, paid_bank_amount: d.importe,
            paid_validated_at: trx.fn.now(), updated_by: autor, updated_at: trx.fn.now(),
          });
        if (!n) return false;
        await trx('finance.payment_allocation_history').insert({
          tenant_id: tenantId, allocation_id: p.id, event: EVENTO_PAGADO_POR_EL_BANCO, status_from: 'pending', status_to: 'executed',
          created_by: autor,
          detail: JSON.stringify({
            regla: 'PGP.121', hoy,
            planeado: { dia: p.dia, importe: Number(p.importe), metodo: p.metodo, cuenta: p.cuenta_planeada },
            banco: { movimiento: d.movimiento_id, cuenta: d.cuenta_id, fecha: d.fecha, importe: d.importe, ...(d.grupo ? { grupo: d.grupo } : {}), ...(d.cheque ? { cheque: d.cheque } : {}) },
          }),
        });
        await this.aplicarRenglonesPagados(trx, tenantId, p.id, autor);
        return true;
      });
      if (!hecho) continue;
      out.pagados++;
      out.monto = round2(out.monto + d.importe);
      out.ids_pagados.push(p.id);
    }
    return out;
  }

  /**
   * `[PGP.130]` **El comprobante dispara el pago** (D1, Edgar 2026-11-17). Aplica los comprobantes que ya casaron
   * con su pago al subirse (`SupplierPaymentProofsService.comprobanteDelCalendario`, regla
   * `casarComprobantesConPagos`): un pago pendiente queda pagado con esa evidencia (`paid_proof_id`) y sus facturas
   * aplicadas; uno que el banco ya había pagado sólo gana su comprobante. Si el pago ya tiene su `X-D-26`, el
   * comprobante pasa a apuntar a ese documento.
   *
   * ⛔ Un pago por transacción, con guarda de carrera (sigue sin comprobante y en el mismo estado). Lo llama
   * `PagosPorElBancoService` en el worker, al aviso de un comprobante nuevo y en cada pasada del banco.
   */
  async pagarPorComprobante(autor = AUTOR_PAGO_POR_COMPROBANTE): Promise<{ revisados: number; pagados: number; ligados: number; ids_pagados: string[] }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const out = { revisados: 0, pagados: 0, ligados: 0, ids_pagados: [] as string[] };
    const filas = await this.tk.run(async (trx) => (await trx.raw(SQL_COMPROBANTES_POR_APLICAR, [tenantId])).rows as {
      comprobante_id: string; id: string; status: string; fecha: string | null; importe: number | null; rastreo: string | null;
      kepler_payment_sucursal: string | null; kepler_payment_doc_prefix: string | null; kepler_payment_folio: string | null;
    }[]);
    out.revisados = filas.length;
    for (const f of filas) {
      const hecho = await this.tk.run(async (trx) => {
        const pendiente = f.status === 'pending';
        const n = await trx('finance.payment_allocations')
          .where({ tenant_id: tenantId, id: f.id, status: f.status }).whereNull('paid_proof_id')
          .update(pendiente
            ? {
              status: 'executed', executed_at: trx.fn.now(), payment_method: trx.raw(`coalesce(payment_method, 'transferencia')`),
              paid_proof_id: f.comprobante_id, paid_validated_at: trx.fn.now(), updated_by: autor, updated_at: trx.fn.now(),
            }
            : { paid_proof_id: f.comprobante_id, updated_at: trx.fn.now() });
        if (!n) return null;
        await trx('finance.payment_allocation_history').insert({
          tenant_id: tenantId, allocation_id: f.id, event: pendiente ? EVENTO_PAGADO_POR_COMPROBANTE : EVENTO_COMPROBANTE_LIGADO,
          status_from: f.status, status_to: 'executed', created_by: autor,
          detail: JSON.stringify({ regla: 'PGP.130', comprobante: { id: f.comprobante_id, fecha: f.fecha, importe: f.importe, rastreo: f.rastreo } }),
        });
        if (pendiente) await this.aplicarRenglonesPagados(trx, tenantId, f.id, autor);
        if (f.kepler_payment_folio && f.kepler_payment_sucursal && f.kepler_payment_doc_prefix) {
          await moverComprobanteAKepler(trx, tenantId, f.id,
            { sucursal: f.kepler_payment_sucursal, doc_prefix: f.kepler_payment_doc_prefix, folio: f.kepler_payment_folio });
        }
        return pendiente ? 'pagado' : 'ligado';
      });
      if (hecho === 'pagado') { out.pagados++; out.ids_pagados.push(f.id); } else if (hecho === 'ligado') out.ligados++;
    }
    return out;
  }

  /**
   * `[PGP.130b]` **El banco confirma lo que pagó el comprobante.** El comprobante dispara el pago el mismo día (D1); el
   * estado de cuenta llega días después y aquí liga su salida al pago (`paid_bank_*`), sin cambiar su estado. Es lo que
   * permite, después, avisar del pago cuyo dinero no aparece (rebote).
   *
   * La regla es la del banco (`decidirPagosPorElBanco`: ±$1, ±3 días de la fecha del COMPROBANTE, uno a uno) medida
   * junto con los pagos pendientes, para que una salida no la reclamen dos. Y además tiene que salir de la MISMA cuenta
   * que leyó el comprobante: si sale de otra, no se liga (`otra_cuenta`). Corre antes que `pagarPorElBanco`.
   */
  async confirmarPorElBanco(hoy: string = todayMx(), autor = AUTOR_PAGO_POR_EL_BANCO): Promise<{ revisados: number; confirmados: number; otra_cuenta: number }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const out = { revisados: 0, confirmados: 0, otra_cuenta: 0 };
    type Fila = { id: string; dia: string; importe: number; metodo: string | null; cuenta_planeada: string | null };
    const leido = await this.tk.run(async (trx) => {
      const porConfirmar = (await trx.raw(SQL_POR_CONFIRMAR_EN_EL_BANCO, [tenantId, hoy, hoy])).rows as Fila[];
      if (!porConfirmar.length) return null;
      const pendientes = (await trx.raw(SQL_PENDIENTES_POR_EL_BANCO, [tenantId, hoy, hoy])).rows as Fila[];
      const todos = [...porConfirmar, ...pendientes];
      const desde = todos.map((p) => p.dia).reduce((a, b) => (b < a ? b : a));
      const salidas = (await trx.raw(SQL_SALIDAS_POR_EL_BANCO, [tenantId, desde, hoy])).rows as SalidaBanco[];
      const ligadas = new Set(((await trx.raw(SQL_SALIDAS_LIGADAS, [tenantId])).rows as { id: string }[]).map((r) => r.id));
      return { porConfirmar, decision: decidirPagosPorElBanco(todos.map((p) => ({ ...p, importe: Number(p.importe) })),
        salidas.map((x) => ({ ...x, importe: Number(x.importe) })), hoy, ligadas) };
    });
    if (!leido) return out;
    out.revisados = leido.porConfirmar.length;
    for (const p of leido.porConfirmar) {
      const d = leido.decision.get(p.id);
      if (!d || d.estado !== 'probado') continue;
      if (p.cuenta_planeada && d.cuenta_id !== p.cuenta_planeada) { out.otra_cuenta++; continue; }
      const hecho = await this.tk.run(async (trx) => {
        const otra = await trx('finance.payment_allocations')
          .where({ tenant_id: tenantId, paid_bank_movement_id: d.movimiento_id }).whereNot({ id: p.id }).whereNot({ status: 'cancelled' }).first('id');
        if (otra) return false;
        const n = await trx('finance.payment_allocations')
          .where({ tenant_id: tenantId, id: p.id, status: 'executed' }).whereNull('paid_bank_movement_id').whereNotNull('paid_proof_id')
          .update({ paid_bank_movement_id: d.movimiento_id, paid_bank_date: d.fecha, paid_bank_amount: d.importe, updated_at: trx.fn.now() });
        if (!n) return false;
        await trx('finance.payment_allocation_history').insert({
          tenant_id: tenantId, allocation_id: p.id, event: EVENTO_CONFIRMADO_POR_EL_BANCO, status_from: 'executed', status_to: 'executed',
          created_by: autor,
          detail: JSON.stringify({ regla: 'PGP.130b', hoy, comprobante: { dia: p.dia, importe: Number(p.importe) },
            banco: { movimiento: d.movimiento_id, cuenta: d.cuenta_id, fecha: d.fecha, importe: d.importe, ...(d.grupo ? { grupo: d.grupo } : {}), ...(d.cheque ? { cheque: d.cheque } : {}) } }),
        });
        return true;
      });
      if (hecho) out.confirmados++;
    }
    return out;
  }

  /**
   * `[PGP.132]` **Lo que Kepler ya pagó, pagado en la Suite** (reporte de Contabilidad, 2026-11-17). Un pago pendiente
   * cuyas facturas Tesorería ya pagó en Kepler (`decidirPagoEnKepler`: el cierre de `[PGP.94]` completo, con dinero)
   * queda `executed`, ligado a ese documento y con sus facturas aplicadas; uno que ya pagó el banco o el comprobante
   * sólo se liga (sale de la fila del escritor de `X-D-26`, que lo rechazaba en cada pasada). Medido ese día: 48 pagos
   * ($10.5 M) pagados en Kepler seguían «pendientes».
   *
   * ⛔ Un pago por transacción, con guarda de carrera (mismo estado y todavía sin ligar). Si la Suite no lo había
   * autorizado, se paga igual (el dinero ya salió, D6) y la bitácora lo dice (`autorizado_en_la_suite: false`).
   * Lo llama `PagosVencidosService` en el worker, con cada aviso de Kepler.
   */
  async pagarPorKepler(hoy: string = todayMx(), autor = AUTOR_PAGO_EN_KEPLER): Promise<{ revisados: number; pagados: number; ligados: number; monto: number; sin_autorizar: number }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const out = { revisados: 0, pagados: 0, ligados: 0, monto: 0, sin_autorizar: 0 };
    type Fila = { id: string; status: string; dia: string; alta: string; importe: number; autorizado: boolean };
    const leido = await this.tk.run(async (trx) => {
      // Los pendientes sólo si su día ya llegó (lo mismo que pinta la pantalla, `pagadoPorKepler`).
      const filas = ((await trx.raw(SQL_POR_LIGAR_A_KEPLER, [tenantId, hoy, hoy])).rows as Fila[]);
      if (!filas.length) return null;
      const items = (await trx('finance.payment_allocation_items').where({ tenant_id: tenantId })
        .whereIn('allocation_id', filas.map((f) => f.id)).select('allocation_id', 'obligation_source', 'obligation_id')) as ItemParaCierre[];
      const cierres = await this.cierresKepler(trx, filas.map((f) => ({ id: f.id, lotDate: f.dia, alta: f.alta })), items);
      return { filas, cierres };
    });
    if (!leido) return out;
    out.revisados = leido.filas.length;
    for (const f of leido.filas) {
      const d = decidirPagoEnKepler(leido.cierres.get(f.id));
      if (!d) continue;
      const pendiente = f.status === 'pending';
      const hecho = await this.tk.run(async (trx) => {
        const liga = {
          kepler_payment_sucursal: d.doc.sucursal, kepler_payment_doc_prefix: d.doc.doc_prefix, kepler_payment_folio: d.doc.folio,
          kepler_payment_linked_by: autor, kepler_payment_linked_at: trx.fn.now(), updated_at: trx.fn.now(),
        };
        const n = await trx('finance.payment_allocations')
          .where({ tenant_id: tenantId, id: f.id, status: f.status }).whereNull('kepler_payment_folio').whereNull('kepler_payment_linked_by')
          .update(pendiente
            ? { ...liga, status: 'executed', executed_at: trx.fn.now(), updated_by: autor,
              ...(d.metodo ? { payment_method: trx.raw('coalesce(payment_method, ?)', [d.metodo]) } : {}) }
            : liga);
        if (!n) return false;
        await trx('finance.payment_allocation_history').insert({
          tenant_id: tenantId, allocation_id: f.id, event: pendiente ? EVENTO_PAGADO_EN_KEPLER : EVENTO_LIGADO_A_KEPLER,
          status_from: f.status, status_to: 'executed', created_by: autor,
          detail: JSON.stringify({
            regla: 'PGP.132', hoy, autorizado_en_la_suite: f.autorizado,
            kepler: { sucursal: d.doc.sucursal, doc: `${d.doc.doc_prefix}-${d.doc.folio}`, tipo: d.doc.tipo, fecha: d.doc.fecha, aplicado: d.doc.aplicado },
          }),
        });
        if (pendiente) await this.aplicarRenglonesPagados(trx, tenantId, f.id, autor);
        // Su comprobante del Calendario, si llegó, pasa a apuntar al documento de Kepler.
        await moverComprobanteAKepler(trx, tenantId, f.id, { sucursal: d.doc.sucursal, doc_prefix: d.doc.doc_prefix, folio: d.doc.folio });
        return true;
      });
      if (!hecho) continue;
      if (pendiente) {
        out.pagados++;
        out.monto = round2(out.monto + Number(f.importe));
        if (!f.autorizado) out.sin_autorizar++;
      } else out.ligados++;
    }
    return out;
  }

  /**
   * `[PGP.97]` **Lo que salió del banco a un proveedor, contra Kepler y contra el programa.** La
   * guía del área de pagos: qué transferencias del workbook todavía no tienen su pago en Kepler, y
   * cuáles salieron sin pasar por el Calendario. Sólo lectura, sin tablas nuevas: la lectura vive
   * en `fuera-de-programa.sql.ts` y la regla en `salida-proveedor.contract.ts`.
   *
   * ⛔ Va en este servicio y no en uno propio a propósito: no toca ningún constructor ni firma
   * inyectada (el arranque de #414 se cayó por una) — usa `tk` y `tenantCtx`, que ya están.
   */
  async fueraDePrograma(desde?: string, hasta?: string): Promise<GuiaFueraDePrograma> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = todayMx();
    const v = ventanaFueraDePrograma(desde, hasta, hoy);
    if ('error' in v) throw new BadRequestException(v.error);
    return this.tk.run((trx) => leerGuiaFueraDePrograma(trx, tenantId, v.desde, v.hasta, hoy));
  }

  /**
   * `[PGP.94]` **El cierre de cada pago contra lo que Kepler hizo de verdad** — sin importer: lee
   * `kepler_ods` en el momento (regla 1). Por factura del pago: lo que todavía se debe, y los
   * documentos de Kepler que la tocaron (`kdxf`, abono → cargo), con su fecha, su cuenta de
   * tesorería y el comprobante PDF subido para ese pago. La regla que lo convierte en estado vive
   * en `cierre-kepler.contract.ts`.
   *
   * ⛔ **Misma cuenta que `analytics.v_supplier_payables`**, columna por columna: aplicaciones por
   * `(sucursal, tipo, subtipo, btrim(folio))` de la factura, y fuera las de un pago CANCELADO con
   * el cruce de `[PGP.67]` (`kdm1.c43 = 'C'`, con el proveedor y el folio sin `btrim`, porque el
   * folio colisiona). Si se separan, el renglón diría «el ERP ya no la debe» y el cierre «sin pagar».
   * Medido el 2026-11-06: 707 de 11,955 aplicaciones de `kdxf` desde septiembre son de cancelados.
   *
   * Sólo las facturas `kepler_payable` se miden; las demás quedan `sin_medir` (ADR-056).
   */
  private async cierresKepler(
    trx: Knex.Transaction,
    pagos: PagoParaCierre[],
    items: ItemParaCierre[],
  ): Promise<Map<string, CierreKeplerPago>> {
    if (!pagos.length) return new Map();
    // `[PGP.197]` La obligación capturada que trae su llave de Kepler se mide como la factura que es; sin esto quedaba
    // «sin medir» y el pago nunca se cerraba ni se ligaba (2 de CF006 «pendientes» desde el 26-oct, pagados en Kepler).
    const capturadas = [...new Set(items.filter((i) => i.obligation_source === 'supplier_payable').map((i) => i.obligation_id))];
    const llaves = capturadas.length
      ? ((await trx('commercial.supplier_payment_obligations').whereIn('id', capturadas)
        .select('id', 'kepler_sucursal as sucursal', 'kepler_doc_tipo as doc_tipo', 'kepler_doc_sub as doc_sub', 'kepler_folio as folio')) as LlaveDeCapturada[])
      : [];
    const medibles = conLlaveDeKepler(items, llaves);
    const ids = idsParaCierre(medibles);
    const filas = ids.length
      ? ((await trx.raw(SQL_CIERRE_KEPLER, [ids, this.tenantCtx.requireTenantId()])).rows as FilaCierreKepler[])
      : [];
    return armarCierres(pagos, medibles, filas);
  }

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
    const habitos = rows as SupplierPaymentHabit[];

    // `[PGP.75]` La CLABE destino, de los comprobantes del propio proveedor (ver `destino-sugerido.ts`).
    // Medido contra prod el 2026-11-04: 55-118 ms. Un proveedor con CLABE y sin hábito de método
    // también entra: la CLABE vale sola.
    const { rows: comp } = await this.tk.run((trx) => trx.raw(
      `SELECT btrim(m.c10) AS proveedor_code, x.clabe, count(*)::int AS comprobantes,
              to_char(max(pr.pago_date), 'YYYY-MM-DD') AS ultima, max(pr.ocr_banco) AS banco, s.id AS supplier_id
         FROM finance.supplier_payment_proofs pr
        CROSS JOIN LATERAL (SELECT (regexp_match(pr.ocr_cuenta_dest, '([0-9]{18})'))[1] AS clabe) x
         JOIN kepler_ods.kdm1 m ON m.sucursal = pr.sucursal AND m.c2 = 'X' AND m.c3 = 'D'
                               AND m.c6 = pr.folio AND btrim(m.c63) = pr.doc_prefix || '-'
         JOIN catalog.suppliers s ON btrim(s.code) = btrim(m.c10) AND s.tenant_id = pr.tenant_id
        WHERE pr.tenant_id = ? AND x.clabe IS NOT NULL AND coalesce(pr.status, '') <> 'rechazado'
        GROUP BY 1, 2, s.id`, [tenantId]));
    const filas = comp as (FilaComprobanteClabe & { supplier_id: string })[];
    const destinos = destinosSugeridos(filas);
    const idDe = new Map(filas.map((f) => [f.proveedor_code.trim(), f.supplier_id]));
    const porCode = new Map(habitos.map((h) => [String(h.proveedor_code).trim(), h]));
    for (const [code, d] of destinos) {
      const h = porCode.get(code);
      if (h) { Object.assign(h, d); continue; }
      habitos.push({
        supplier_id: idDe.get(code)!, proveedor_code: code,
        metodo_estado: 'sin_historial', metodo_sugerido: null, metodo_veces: null, metodo_de: null, metodo_ultima_vez: null,
        cuenta_estado: 'sin_historial', cuenta_origen_id: null, cuenta_origen_nombre: null, cuenta_veces: null, cuenta_de: null,
        ...d,
      });
    }
    return habitos;
  }

  /** El lote del día tal cual (folio/status/released_by/at) — usado por el documento imprimible. */
  async getLot(date: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first());
  }

  // ── Crear un pago (fecha + monto; SIN método/banco — criterio #4) ────────────────────
  async createAllocation(dto: CreateAllocationDto, username: string): Promise<AllocationRowLite> {
    this.assertDate(dto.date);
    if (!dto.items?.length) throw new BadRequestException('Se requiere al menos una obligación');
    const tenantId = this.tenantCtx.requireTenantId();
    // `[PGP.91]` Cada item se normaliza ANTES de abrir la transacción: un descuento mal capturado
    // (motivo sin pesos, «Otro» sin detalle, una tasa que no cuadra) no llega a la base. También
    // revisa `applied_amount > 0` (mismo mensaje de siempre), que antes se revisaba en el ciclo.
    const items = dto.items.map((it) => ({ ...it, ...normalizarDescuento(it) }));
    return this.tk.run(async (trx) => {
      const classifications = new Set<string>();
      const payees = new Set<string>();
      const branches = new Set<string>();
      for (const it of items) {
        if (!(it.obligation_source in CLASSIFICATION_BY_SOURCE)) throw new BadRequestException('obligation_source inválido');
        const row = await this.loadObligationRow(trx, tenantId, it.obligation_source, it.obligation_id);
        // `[TP.18]` Para el origen derivado, "no encontrada" también significa **Kepler ya no la
        // debe** (la vista sólo trae saldo > 0): no se programa, que es el mismo veredicto.
        if (!row) throw new NotFoundException(`Obligación ${it.obligation_id} no encontrada`);
        if (row.status === 'cancelled') throw new BadRequestException('La obligación está cancelada');
        // `[PGP.126]` `nature` sólo existe en `supplier_payable` (el anticipo pedido en la Suite).
        assertDescuentoPermitido(it.obligation_source, classificationOf(it.obligation_source, row), it.discount_amount, row.nature);
        const available = Number(row.original_amount) - Number(row.reserved_amount) - Number(row.paid_amount);
        // `[PGP.91]` Contra el disponible y contra Kepler se mide lo CUBIERTO (neto + descuento):
        // es lo que la factura deja de deber cuando llegue la nota de crédito.
        if (it.covered > available + 0.005) throw new BadRequestException(`Excede el saldo disponible de la obligación (disponible: ${available.toFixed(2)})`);
        await this.assertKeplerBalance(trx, it.obligation_source, row, it.covered);
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
      // `[PGP.91]` NETO: lo que sale del banco. El descuento no es dinero que salga.
      const amountAssigned = round2(items.reduce((s, it) => s + it.applied_amount, 0));
      const [allocation] = await trx('finance.payment_allocations').insert({
        tenant_id: tenantId, lot_id: lot.id, classification: [...classifications][0],
        priority_rank: dto.priority_rank ?? null, amount_assigned: amountAssigned,
        notes: dto.notes ?? null, created_by: username,
      }).returning('*');
      for (const it of items) {
        const conDescuento = it.discount_amount > 0;
        await trx('finance.payment_allocation_items').insert({
          tenant_id: tenantId, allocation_id: allocation.id, obligation_source: it.obligation_source,
          obligation_id: it.obligation_id, applied_amount: it.applied_amount,
          discount_amount: it.discount_amount, discount_reason: it.discount_reason,
          discount_rate: it.discount_rate, discount_note: it.discount_note,
          // `[PGP.91]` Quién y cuándo fijó el descuento: cambia dinero y la tabla no tiene `updated_by`.
          discount_by: conDescuento ? username : null, discount_at: conDescuento ? trx.fn.now() : null,
        });
        await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      }
      return allocation;
    });
  }

  async addItem(allocationId: string, item: AllocationItemDto, username: string): Promise<AllocationRowLite> {
    const tenantId = this.tenantCtx.requireTenantId();
    // `[PGP.91]` Mismo normalizador que `createAllocation`: un solo lugar decide si el descuento vale.
    const norm = normalizarDescuento(item);
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se puede modificar un pago pendiente');
      assertSinAutorizar(allocation);
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
      assertDescuentoPermitido(item.obligation_source, allocation.classification, norm.discount_amount, row.nature);
      const available = Number(row.original_amount) - Number(row.reserved_amount) - Number(row.paid_amount);
      // `[PGP.91]` Lo CUBIERTO (neto + descuento) contra el disponible y contra Kepler.
      if (norm.covered > available + 0.005) throw new BadRequestException(`Excede el saldo disponible de la obligación (disponible: ${available.toFixed(2)})`);
      await this.assertKeplerBalance(trx, item.obligation_source, row, norm.covered);
      // `[TP.16.3]` Lo que se agrega a un pago existente tiene el mismo beneficiario y sucursal que lo que ya trae.
      const [first] = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId }).whereNot({ obligation_id: item.obligation_id }).orderBy('created_at', 'asc').limit(1);
      if (first) {
        const firstRow = await this.loadObligationRow(trx, tenantId, first.obligation_source as ObligationSource, first.obligation_id);
        const a = paymentGroupKey(first.obligation_source, firstRow ?? {}), b = paymentGroupKey(item.obligation_source, row);
        if (a.payee !== b.payee) throw new BadRequestException('Esta factura es de otro beneficiario: un pago es una sola transferencia a una sola cuenta.');
        if (a.branch !== b.branch) throw new BadRequestException(`Esta factura es de la sucursal ${b.branch} y el pago es de la ${a.branch}: cada pago entra al centro de costo de su almacén.`);
      }
      const conDescuento = norm.discount_amount > 0;
      await trx('finance.payment_allocation_items').insert({
        tenant_id: tenantId, allocation_id: allocationId, obligation_source: item.obligation_source,
        obligation_id: item.obligation_id, applied_amount: norm.applied_amount,
        discount_amount: norm.discount_amount, discount_reason: norm.discount_reason,
        discount_rate: norm.discount_rate, discount_note: norm.discount_note,
        // `[PGP.91]` Quién y cuándo fijó el descuento (la tabla no tiene `updated_by`).
        discount_by: conDescuento ? username : null, discount_at: conDescuento ? trx.fn.now() : null,
      });
      await this.recalcObligation(trx, item.obligation_source, item.obligation_id);
      await this.recalcAllocationTotal(trx, allocationId);
      return trx('finance.payment_allocations').where({ id: allocationId }).first();
    });
  }

  async removeItem(allocationId: string, itemId: string, username = 'sistema'): Promise<{ ok: boolean }> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const item = await trx('finance.payment_allocation_items').where({ tenant_id: tenantId, id: itemId, allocation_id: allocationId }).first();
      if (!item) throw new NotFoundException('Documento no encontrado en este pago');
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se puede modificar un pago pendiente');
      assertSinAutorizar(allocation);
      // `[PGP.92]` Quitar una factura de un día YA AUTORIZADO cambiaría un importe que Gerencia firmó.
      // `addItem` ya lo impedía (TP.16.4); aquí sólo lo escondía la pantalla, y la pantalla no es un
      // candado. Va ANTES del conteo para que el rechazo diga la causa verdadera.
      const lot = await trx('finance.payment_calendar_lots').where({ id: allocation.lot_id }).first();
      if (lot && LOCKED_LOT_STATUSES.has(lot.status)) throw new BadRequestException('El día ya fue autorizado: no se le pueden quitar facturas a sus pagos (muévelo a otro día).');
      const [{ count }] = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId }).whereNot('id', itemId).count();
      if (Number(count) === 0) throw new BadRequestException('Un pago debe tener al menos un documento — cancela el pago en vez de vaciarlo');
      await trx('finance.payment_allocation_items').where({ id: itemId }).del();
      await this.recalcObligation(trx, item.obligation_source, item.obligation_id);
      await this.recalcAllocationTotal(trx, allocationId);
      // `[PGP.92]` Quién cambió el pago: quitar una factura cambia su importe.
      await trx('finance.payment_allocations').where({ id: allocationId }).update({ updated_by: username, updated_at: trx.fn.now() });
      return { ok: true };
    });
  }

  /**
   * `[PGP.91]` **El descuento al pagar se fija SOBRE la factura ya puesta en el pago.** Lo cubierto no
   * cambia (el disponible tampoco: no hay candado de Kepler que repetir); baja lo que sale del banco.
   * 0 lo quita. Nace porque en el rediseño casi toda factura entra COMPLETA (el «+», los grupos, la
   * propuesta del día): sin esto, descontar una ya puesta obligaba a quitarla y volver a agregarla,
   * y si era la única del pago no se podía.
   * Sólo pago pendiente de un día SIN autorizar: en uno autorizado cambiaría lo que Gerencia firmó.
   */
  async setItemDiscount(allocationId: string, itemId: string, body: ItemDiscountDto, username: string): Promise<PaymentCalendarItemDiscountResult> {
    const tenantId = this.tenantCtx.requireTenantId();
    // ⛔ Sin `discount_amount` no se adivina: para el validador «vacío» es 0, y un cuerpo perdido
    // QUITARÍA el descuento en silencio. Quitarlo se pide explícito, con 0 (el contrato lo exige).
    // `null` y '' cuentan como ausentes: el validador también los leería como 0.
    // `[PGP.101]` Con `discounts` llega la lista completa (`[]` lo quita, explícito); sin ella, el cuerpo de un solo descuento.
    const varios = body?.discounts !== undefined && body?.discounts !== null;
    const monto = body?.discount_amount;
    if (!varios && (monto === undefined || monto === null || (typeof monto === 'string' && monto.trim() === ''))) {
      throw new BadRequestException('Falta el descuento (discount_amount): manda 0 para quitarlo.');
    }
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).forUpdate().first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se puede modificar un pago pendiente');
      assertSinAutorizar(allocation);
      const lot = await trx('finance.payment_calendar_lots').where({ id: allocation.lot_id }).first();
      if (lot && LOCKED_LOT_STATUSES.has(lot.status)) throw new BadRequestException('El día ya fue autorizado: no se le puede cambiar el descuento a sus pagos (muévelo a otro día).');
      // ⛔ `forUpdate` también en la factura: si otra sesión la quita al mismo tiempo, esta lectura
      // espera y ve que ya no está, en vez de «actualizar» cero filas y devolver un neto inventado.
      const item = await trx('finance.payment_allocation_items').where({ tenant_id: tenantId, id: itemId, allocation_id: allocationId }).forUpdate().first();
      if (!item) throw new NotFoundException('Documento no encontrado en este pago');
      // `numeric` llega como texto del driver: se convierte ANTES de sumar.
      const cubierto = Number(item.applied_amount) + Number(item.discount_amount ?? 0);
      const norm: DescuentosNormalizados = varios
        ? descuentosSobreCubierto(cubierto, body.discounts)
        : (() => {
            const n = descuentoSobreCubierto(cubierto, body);
            return { ...n, lines: n.discount_amount > 0 ? [{ reason: n.discount_reason!, amount: n.discount_amount, rate: n.discount_rate, note: n.discount_note }] : [] };
          })();
      // `[PGP.126]` El anticipo pedido en la Suite se paga completo. `.first()` sin columnas: lee
      // `nature` sin nombrarla, así que no truena si la migración `pgp119` todavía no llegó.
      const nature = item.obligation_source === 'supplier_payable'
        ? (await trx('commercial.supplier_payment_obligations').where({ tenant_id: tenantId, id: item.obligation_id }).first())?.nature
        : null;
      assertDescuentoPermitido(item.obligation_source, allocation.classification, norm.discount_amount, nature);
      // `[PGP.120]` Un renglón «Anticipo» se verifica contra Kepler: documento, acreedor, sucursal y disponible.
      await this.verificarAnticipos(trx, tenantId, item, norm.lines);
      const con = norm.discount_amount > 0;
      await trx('finance.payment_allocation_items').where({ id: itemId }).update({
        applied_amount: norm.applied_amount, discount_amount: norm.discount_amount, discount_reason: norm.discount_reason,
        discount_rate: norm.discount_rate, discount_note: norm.discount_note,
        // ⛔ JSON.stringify: knex manda un arreglo JS como arreglo de Postgres, no como jsonb.
        discount_lines: con ? JSON.stringify(norm.lines) : null,
        discount_by: con ? username : null, discount_at: con ? trx.fn.now() : null,
      });
      // Lo cubierto es igual y el disponible no se mueve; se llama por la invariante (un solo
      // lugar escribe reservado/pagado), no porque el número cambie.
      await this.recalcObligation(trx, item.obligation_source as ObligationSource, item.obligation_id);
      await this.recalcAllocationTotal(trx, allocationId);
      const [a] = await trx('finance.payment_allocations').where({ id: allocationId })
        .update({ updated_by: username, updated_at: trx.fn.now() }).returning(['amount_assigned']);
      return {
        allocation_id: allocationId, item_id: itemId,
        applied_amount: norm.applied_amount, discount_amount: norm.discount_amount,
        amount_assigned: Number(a.amount_assigned),
      };
    });
  }

  /**
   * Reprograma: cancela el pago actual (libera el día viejo) y crea uno nuevo en la fecha nueva.
   * TP.10 — exige motivo (cerrado + 'otro' con detalle libre): permite reprogramar un pago
   * PENDIENTE (ej. presupuesto recortado) o uno FALLIDO (cuenta errónea/banco/devuelto/otro).
   */
  async reprogram(
    allocationId: string, newDate: string, reason: ReprogramReason, reasonDetail: string | undefined, username: string, hoy: string = todayMx(),
    aunqueSalio?: string,
  ): Promise<AllocationRowLite & PaymentCalendarReprogramado> {
    this.assertDate(newDate);
    if (!REPROGRAM_REASONS.includes(reason)) throw new BadRequestException(`reason inválido — debe ser uno de: ${REPROGRAM_REASONS.join(', ')}`);
    if (reason === 'otro' && !reasonDetail?.trim()) throw new BadRequestException('reasonDetail es requerido cuando reason = "otro"');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (!['pending', 'failed'].includes(allocation.status)) throw new BadRequestException('Solo se puede reprogramar un pago pendiente o fallido');
      // `[PGP.199]` Un pago fallido ya rebotó (su salida se devolvió y no cuenta): la guarda sólo encuentra dinero que sí salió.
      await this.assertNoSalio(trx, tenantId, allocation, 'reprogramar', username, aunqueSalio, hoy);
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
        // `[PGP.190]` La transferencia movida sigue siendo parte de su pago partido (sólo si la columna ya existe).
        ...(allocation.split_from_id ? { split_from_id: allocation.split_from_id } : {}),
      }).returning('*');
      for (const it of items as any[]) {
        // `[PGP.91]` El descuento al pagar viaja con la factura: reprogramar cambia el DÍA, no lo
        // que el proveedor concedió. Sin copiarlo, el día nuevo pagaría el neto y dejaría el
        // descuento otra vez disponible — la misma factura cubierta de menos. Quién y cuándo lo
        // fijó también viajan: reprogramar no es volver a capturarlo.
        await trx('finance.payment_allocation_items').insert({
          tenant_id: tenantId, allocation_id: newAllocation.id, obligation_source: it.obligation_source,
          obligation_id: it.obligation_id, applied_amount: it.applied_amount, agreement_id: it.agreement_id,
          discount_amount: it.discount_amount ?? 0, discount_reason: it.discount_reason ?? null,
          discount_rate: it.discount_rate ?? null, discount_note: it.discount_note ?? null,
          discount_by: it.discount_by ?? null, discount_at: it.discount_at ?? null,
          // `[PGP.101]` Los renglones viajan también (el driver los devuelve parseados: se vuelven a serializar).
          discount_lines: it.discount_lines ? JSON.stringify(it.discount_lines) : null,
        });
        await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      }
      // `[PGP.184]` **El pago que nace al reprogramar no lleva más de lo que su factura debe HOY** (Francisco, 2026-11-20:
      // «cuando un proveedor ya está agendado y se le aplica una nota de crédito o devolución, y aún no está pagada, se
      // debe actualizar el calendario»). Reprogramar copiaba el importe viejo sin compararlo con Kepler (crear y agregar sí
      // lo comparan). Caso CE012 (prod, anexo C §4b): factura programada el 10-nov, cuatro notas de crédito de ese mismo
      // día, reprogramada el 18 a ese mismo día con el importe completo; al 20-nov seguía pendiente con lo de las notas de
      // más. Medido: 27 de 55 reprogramaciones van a hoy o a un día pasado. Dentro de D19 (b), igual que el worker:
      // · a un día POR VENIR y sin autorización previa: baja solo, con las reglas del worker (sólo lo que explica una nota
      //   o devolución sin dinero desde el armado ORIGINAL; nunca sube; la factura con descuento no se toca) y el banco se
      //   mira desde el día ORIGINAL — con el día nuevo, más adelante, la ventana quedaba vacía;
      // · a HOY o a un día pasado, o si venía autorizado: no se escribe nada (pudo ya salir del banco por su importe esta
      //   mañana; bajarlo dejaría esa salida sin pago que case con ella), pero la respuesta lo dice y la pantalla lo avisa
      //   al moverlo, con «Bajar a» en su renglón.
      // En su propio punto de guardado: si el ajuste falla, el pago se mueve igual y el aviso rojo de `[PGP.147]` sigue.
      const loteViejo = await trx('finance.payment_calendar_lots').where({ id: allocation.lot_id })
        .first('status', trx.raw("to_char(lot_date, 'YYYY-MM-DD') AS dia")) as { status: string; dia: string } | undefined;
      const veniaAutorizado = !!allocation.authorized_at || (!!loteViejo && LOCKED_LOT_STATUSES.has(loteViejo.status));
      const soloAvisar = veniaAutorizado ? MOTIVO_NO_AJUSTA_AUTORIZADO : newDate <= hoy ? MOTIVO_NO_AJUSTA_HOY_O_PASADO : undefined;
      const diaBancoDesde = loteViejo?.dia && loteViejo.dia < newDate ? loteViejo.dia : newDate;
      let ajuste: PaymentCalendarAjusteAlSaldo | null = null;
      try {
        ajuste = await trx.transaction((sp) => this.ajustarAlSaldoEn(sp, tenantId, newAllocation.id, username, 'reprogramar', hoy, { soloAvisar, diaBancoDesde }));
      } catch (e: unknown) {
        // Ya salió del banco por su importe (u otra regla del ajuste): se mueve igual. Lo inesperado se registra como aviso.
        const msg = `[PGP.184] el pago ${newAllocation.id} se reprogramó sin ajustarlo al saldo de Kepler: ${(e as Error)?.message}`;
        if (e instanceof BadRequestException) this.logger.log(msg); else this.logger.warn(msg);
      }
      const reprogramado: AllocationRowLite & PaymentCalendarReprogramado = {
        ...newAllocation,
        amount_assigned: ajuste ? ajuste.amount_assigned : Number(newAllocation.amount_assigned),
        ajuste_al_saldo: ajuste && (ajuste.ajustadas.length || ajuste.omitidas.length) ? ajuste : null,
      };
      return reprogramado;
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
    return this.tk.run((trx) => this.prepareEn(trx, tenantId, allocationId, dto, username));
  }

  /**
   * `[PGP.190]` El cuerpo de `prepare`, dentro de una transacción: preparar en varias transferencias prepara cada parte con
   * las MISMAS reglas (cuenta destino, CLABE, mismo banco, anticipo) en la transacción que la parte. `pedirAltaDeCuenta`
   * en `false` para la 2ª parte en adelante: la CLABE a mano se pide de alta una vez por pago, no una por transferencia.
   */
  private async prepareEn(
    trx: Knex.Transaction, tenantId: string, allocationId: string, dto: PrepareAllocationDto, username: string,
    opciones: { pedirAltaDeCuenta?: boolean } = {},
  ) {
    if (!['transferencia', 'cheque', 'efectivo', 'cargo_automatico'].includes(dto.payment_method)) throw new BadRequestException('payment_method inválido');
    const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
    if (!allocation) throw new NotFoundException('Pago no encontrado');
    if (allocation.status !== 'pending') throw new BadRequestException('Solo se prepara un pago pendiente');
    assertSinAutorizar(allocation);

    // `[TP.16]` La cuenta DESTINO sólo existe para transferencia / cargo automático. En efectivo o
    // cheque se descarta: si no, la favorita del proveedor (o un texto de una preparación anterior)
    // terminaba impresa como destino en la instrucción a Caja General.
    const usesDestination = dto.payment_method === 'transferencia' || dto.payment_method === 'cargo_automatico';
    let destinationText = usesDestination ? dto.destination_account_text ?? null : null;
    const accountId = usesDestination ? dto.supplier_payment_account_id ?? null : null;
    let cuentaElegida: { clabe: string | null; account_number: string | null } | null = null;
    let destinoCatalogo: { clabe: string | null; bank_name: string | null; account_number: string | null } | null = null;
    if (accountId) {
      const acc = await trx('commercial.supplier_payment_accounts').where({ tenant_id: tenantId, id: accountId, status: 'activa' }).first();
      if (!acc) throw new BadRequestException('La cuenta de pago seleccionada no existe o está inactiva');
      // `[PGP.155]` También el número de cuenta: el anticipo a una cuenta sin CLABE se compara por él.
      cuentaElegida = { clabe: acc.clabe ? String(acc.clabe).replace(/\D/g, '') : null, account_number: acc.account_number ?? null };
      destinoCatalogo = { clabe: acc.clabe ?? null, bank_name: acc.bank_name ?? null, account_number: acc.account_number ?? null };
      // [PGP.90] La referencia fija viaja en el snapshot: es lo que imprime la instrucción a Caja
      // General y lo que el banco tiene que llevar, o el proveedor no reconoce el depósito.
      destinationText = `${acc.bank_name}${acc.clabe ? ' · CLABE ' + acc.clabe : ''}${acc.account_number ? ' · Cta ' + acc.account_number : ''}${acc.payment_reference ? ' · Ref ' + acc.payment_reference : ''}${acc.alias ? ' (' + acc.alias + ')' : ''}`;
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
      // `[PGP.155]` A una cuenta del catálogo SIN CLABE no hay SPEI: sólo sale de una cuenta nuestra del mismo
      // banco (VUMERSOFT: BBVA a BBVA). Qué cuenta de ese banco, la decide la Tesorería (`[PGP.75]`).
      // `[PGP.155.2]` Sólo en TRANSFERENCIA (revisión independiente): en un cargo automático el proveedor cobra
      // de nuestra cuenta y el banco de su cuenta no ata el origen. Y una tarjeta de 16 dígitos no ata (SPEI).
      if (dto.payment_method === 'transferencia') {
        const otroBanco = faltaOrigenMismoBanco({ destino: destinoCatalogo, origen: { bank: origin.bank ?? null, kind: origin.kind ?? null } });
        if (otroBanco) throw new BadRequestException(otroBanco);
      }
    }
    /**
     * `[PGP.128]` D12 — **el anticipo se transfiere sólo a la cuenta APROBADA de su cotización.** Una CLABE
     * tecleada aquí quedaría pedida de alta (`[PGP.46]`) pero el dinero ya habría salido a una cuenta que
     * nadie revisó: justo el fraude de la cotización con la CLABE cambiada. `to_jsonb(o)`: no truena si la
     * migración `pgp127` todavía no llegó (sin `payee_clabe`, pide igual una cuenta aprobada). Va ANTES del
     * «Transferencia requiere la cuenta destino» genérico: en un anticipo, el aviso dice cuál cuenta.
     */
    if (usesDestination) {
      const { rows: ants } = await trx.raw(
        `SELECT to_jsonb(o) ->> 'payee_clabe' AS clabe, to_jsonb(o) ->> 'payee_account_number' AS cuenta
           FROM finance.payment_allocation_items i
           JOIN commercial.supplier_payment_obligations o ON o.id = i.obligation_id AND o.tenant_id = ?
          WHERE i.allocation_id = ? AND i.obligation_source = 'supplier_payable' AND to_jsonb(o) ->> 'nature' = 'anticipo'`,
        [tenantId, allocationId]);
      const filas = ants as { clabe: string | null; cuenta: string | null }[];
      const falta = faltaCuentaParaTransferirAnticipo({
        clabesDeAnticipos: filas.map((r) => r.clabe ?? null), cuentasDeAnticipos: filas.map((r) => r.cuenta ?? null), cuentaElegida,
      });
      if (falta) throw new BadRequestException(falta);
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
    /**
     * `[PGP.157]` **Un anticipo en efectivo sale de la Caja General de SU base** (cada base cuadra sola; Francisco,
     * 2026-11-19): el de una compra de Morelia sale de la 08, se captura en su Kepler y se aplica a su factura. Por eso
     * la caja no se teclea: se DERIVA de la sucursal del anticipo (la de su OC). Así la ve Caja General «por entregar»
     * al autorizarlo. Otro pago en efectivo sigue con la caja escrita a mano (la regla de antes).
     */
    let cajaTexto = dto.payment_method === 'efectivo' ? dto.cash_register_text?.trim() || null : null;
    if (dto.payment_method === 'efectivo') {
      const { rows: bases } = await trx.raw(
        `SELECT DISTINCT nullif(btrim(o.kepler_sucursal), '') AS sucursal FROM finance.payment_allocation_items i
           JOIN commercial.supplier_payment_obligations o ON o.id = i.obligation_id AND o.tenant_id = ?
          WHERE i.allocation_id = ? AND i.obligation_source = 'supplier_payable' AND to_jsonb(o) ->> 'nature' = 'anticipo'`,
        [tenantId, allocationId]);
      const sucursales = (bases as { sucursal: string | null }[]).map((b) => b.sucursal);
      if (sucursales.length > 1 || sucursales.includes(null)) {
        throw new BadRequestException('Este pago lleva anticipos sin una sola sucursal: no se sabe de qué Caja General sale el efectivo.');
      }
      if (sucursales.length === 1) cajaTexto = cajaDeSalidaTexto(sucursales[0] as string);
      if (!cajaTexto) throw new BadRequestException('Efectivo requiere la caja de salida');
    }

    const [updated] = await trx('finance.payment_allocations').where({ id: allocationId }).update({
      payment_method: dto.payment_method, bank_account_id: needsOrigin ? dto.bank_account_id : null,
      destination_account_text: destinationText, cash_register_text: cajaTexto,
      reference_text: dto.reference_text ?? null, supplier_payment_account_id: accountId,
      updated_by: username, updated_at: trx.fn.now(),
    }).returning('*');

    /**
     * `[PGP.46]` **La CLABE tecleada a mano queda PEDIDA de alta, para no teclearla otra vez.**
     *
     * Medido el 2026-11-03: el catálogo está en **0 filas**, y el Calendario lleva **146 pagos
     * y 0 preparados jamás** (33 lotes, todos `draft`). Quien prepara tecleaba 18 dígitos que
     * se guardaban **sólo en ese pago**; la semana siguiente, el mismo proveedor, los mismos 18
     * dígitos. El acto ya ocurre: lo que faltaba era quedárselo.
     *
     * ⛔ **Sólo cuando se capturó a mano** (`!accountId`): si la cuenta salió del catálogo, ya
     * está dada de alta y pedirla de nuevo ensuciaría la bandeja de quien aprueba.
     *
     * ⚠️ **Fuera de la transacción del pago, y sin propagar el error.** El pago ya quedó
     * guardado arriba; esto es accesorio. Si el catálogo falla, se registra y se sigue — un
     * pago que no se puede preparar porque el catálogo tuvo un problema sería peor que volver
     * a teclear la CLABE.
     */
    if (!accountId && destinationText && this.cuentas && opciones.pedirAltaDeCuenta !== false) {
      const supplierId = await this.proveedorDeAllocation(trx, tenantId, allocationId);
      if (supplierId) {
        try {
          const r = await this.cuentas.registrarDesdePago(
            supplierId, destinationText, username,
            `Capturada al preparar el pago ${allocationId} el ${new Date().toISOString().slice(0, 10)}.`,
          );
          if (r.resultado === 'pedida') {
            this.logger.log(`[PGP.46] alta de cuenta pedida para el proveedor ${supplierId} desde el pago ${allocationId}`);
          }
        } catch (e) {
          this.logger.warn(`[PGP.46] el pago ${allocationId} quedó preparado, pero no se pudo pedir el alta de su cuenta: ${String((e as Error)?.message ?? e)}`);
        }
      }
    }
    return updated;
  }

  /**
   * `[PGP.190]` **Preparar un pago que sale en varias transferencias** (Francisco, 2026-11-20: «hay pagos que se hacen con
   * varias transferencias»; eligió «Partir en pagos»). El pago se parte en un pago por transferencia, en el mismo día, y
   * cada uno queda preparado: la misma cuenta destino y su propia cuenta de origen. Así cada transferencia se casa sola
   * con su salida del banco, lleva su comprobante y su X-D-26 en Kepler, como hoy lo hace Tesorería a mano (medido: CE012
   * 31-ago, una factura abonada con dos X-D-26, un millón y el resto). Reparto y reglas: `partir-en-transferencias.ts`.
   *
   * ⛔ Sólo un pago pendiente, sin autorizar y de un día abierto (como preparar). ⛔ Un anticipo no se parte: sale a la
   * cuenta aprobada de su cotización en un solo movimiento (`[PGP.128]` D12). Todo o nada: una transacción.
   */
  async prepararEnTransferencias(allocationId: string, dto: PrepararEnTransferenciasDto, username: string): Promise<PaymentCalendarPartido> {
    const tenantId = this.tenantCtx.requireTenantId();
    const lista = Array.isArray(dto?.transferencias) ? (dto.transferencias as { amount?: unknown; bank_account_id?: unknown }[]) : [];
    const importes = lista.map((t) => (typeof t?.amount === 'number' ? t.amount : typeof t?.amount === 'string' && t.amount.trim() ? Number(t.amount) : NaN));
    const origenes = lista.map((t) => (typeof t?.bank_account_id === 'string' ? t.bank_account_id.trim() : ''));
    const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const destino: Pick<PrepareAllocationDto, 'supplier_payment_account_id' | 'destination_account_text'> = {
      supplier_payment_account_id: texto(dto?.supplier_payment_account_id), destination_account_text: texto(dto?.destination_account_text),
    };
    return this.tk.run(async (trx) => {
      const a = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).forUpdate().first();
      if (!a) throw new NotFoundException('Pago no encontrado');
      if (!('split_from_id' in a)) throw new ServiceUnavailableException('Falta aplicar la migración pgp190 (pago partido en transferencias): avisa a Sistemas.');
      if (a.status !== 'pending') throw new BadRequestException('Sólo se parte un pago pendiente.');
      assertSinAutorizar(a);
      const lot = await trx('finance.payment_calendar_lots').where({ id: a.lot_id }).first('status') as { status: string } | undefined;
      if (lot && LOCKED_LOT_STATUSES.has(lot.status)) throw new BadRequestException('El día ya fue autorizado: sus pagos ya no se parten.');
      const items = await trx('finance.payment_allocation_items').where({ tenant_id: tenantId, allocation_id: allocationId }).forUpdate()
        .orderBy([{ column: 'created_at' }, { column: 'id' }])
        .select('id', 'obligation_source', 'obligation_id', 'applied_amount', 'discount_amount', 'agreement_id') as {
          id: string; obligation_source: ObligationSource; obligation_id: string;
          applied_amount: string | number; discount_amount: string | number | null; agreement_id: string | null;
        }[];
      const { rows: anticipos } = await trx.raw(
        `SELECT 1 FROM finance.payment_allocation_items i
           JOIN commercial.supplier_payment_obligations o ON o.id = i.obligation_id AND o.tenant_id = ?
          WHERE i.allocation_id = ? AND i.obligation_source = 'supplier_payable' AND to_jsonb(o) ->> 'nature' = 'anticipo' LIMIT 1`,
        [tenantId, allocationId]);
      if (anticipos.length) throw new BadRequestException('Un anticipo no se parte en transferencias: sale en una sola, a la cuenta aprobada de su cotización.');
      if (origenes.length !== importes.length || origenes.some((o) => !o)) throw new BadRequestException('Elige la cuenta de origen de cada transferencia.');

      // El reparto, con el nombre de cada factura para los avisos (las de Kepler por su folio).
      const keplerIds = items.filter((i) => i.obligation_source === 'kepler_payable').map((i) => String(i.obligation_id));
      const saldos = await this.saldosDeKepler(trx, keplerIds);
      const nombreDe = (obligationId: string) => {
        const c = cargoDeLaFactura({ entity_ref: saldos.get(String(obligationId))?.entity_ref ?? null, payee_code: 'x' });
        return c ? `${c.tipo}-${c.sub}-${c.folio}` : 'del pago';
      };
      let partes: ParteDelPago[];
      try {
        partes = partirEnTransferencias(items.map((i) => ({
          id: String(i.id), applied_amount: Number(i.applied_amount), discount_amount: Number(i.discount_amount ?? 0), factura: nombreDe(i.obligation_id),
        })), importes);
      } catch (e: unknown) {
        if (e instanceof ErrorAlPartir) throw new BadRequestException(e.message);
        throw e;
      }

      // La 1ª transferencia se queda en el pago original; las demás nacen en el mismo día, en el orden escrito
      // (`clock_timestamp()`: dentro de una transacción `now()` es el mismo para todas y «2 de 3» saldría al azar).
      const grupo = String(a.split_from_id ?? a.id);
      const ids: string[] = [String(a.id)];
      for (let k = 1; k < partes.length; k++) {
        const [nueva] = await trx('finance.payment_allocations').insert({
          tenant_id: tenantId, lot_id: a.lot_id, classification: a.classification, priority_rank: a.priority_rank,
          amount_assigned: partes[k].importe, notes: a.notes, split_from_id: grupo, created_by: username, created_at: trx.raw('clock_timestamp()'),
        }).returning('id');
        ids.push(String((nueva as { id: string }).id));
      }
      await trx('finance.payment_allocations').where({ id: a.id }).update({ split_from_id: grupo, updated_by: username, updated_at: trx.fn.now() });

      // Los renglones: la 1ª vez que aparece un renglón se mueve (o se queda) con su tramo; si su factura cruza a la
      // siguiente transferencia, ese tramo es un renglón nuevo (sin descuento: el que lo lleva no se parte).
      const porId = new Map(items.map((i) => [String(i.id), i]));
      const visto = new Set<string>();
      for (let k = 0; k < partes.length; k++) {
        for (const t of partes[k].tramos) {
          const it = porId.get(t.item_id);
          if (!it) throw new Error(`[PGP.190] el reparto devolvió un renglón que el pago no tiene (${t.item_id})`);
          if (!visto.has(t.item_id)) {
            visto.add(t.item_id);
            await trx('finance.payment_allocation_items').where({ id: t.item_id }).update({ allocation_id: ids[k], applied_amount: t.applied_amount });
          } else {
            await trx('finance.payment_allocation_items').insert({
              tenant_id: tenantId, allocation_id: ids[k], obligation_source: it.obligation_source, obligation_id: it.obligation_id,
              applied_amount: t.applied_amount, agreement_id: it.agreement_id ?? null, discount_amount: 0,
            });
          }
        }
      }
      for (const id of ids) await this.recalcAllocationTotal(trx, id);
      const obligaciones = new Map(items.map((i) => [`${i.obligation_source}:${i.obligation_id}`, i]));
      for (const i of obligaciones.values()) await this.recalcObligation(trx, i.obligation_source, String(i.obligation_id));

      // Cada parte, preparada con las mismas reglas que «Preparar pago» (destino, CLABE, mismo banco).
      for (let k = 0; k < ids.length; k++) {
        await this.prepareEn(trx, tenantId, ids[k], { payment_method: 'transferencia', bank_account_id: origenes[k], ...destino }, username, { pedirAltaDeCuenta: k === 0 });
      }

      const resumen = ids.map((id, k) => ({ id, importe: partes[k].importe, origen: origenes[k] }));
      for (const id of ids) {
        await trx('finance.payment_allocation_history').insert({
          tenant_id: tenantId, allocation_id: id, event: EVENTO_PARTIDO_EN_TRANSFERENCIAS, status_from: 'pending', status_to: 'pending', created_by: username,
          detail: JSON.stringify({ regla: 'PGP.190', original: String(a.id), antes: Number(a.amount_assigned), partes: resumen }),
        });
      }
      const filas = await trx('finance.payment_allocations').whereIn('id', ids).select('id', 'amount_assigned', 'bank_account_id');
      const porPago = new Map((filas as { id: string; amount_assigned: string | number; bank_account_id: string | null }[]).map((f) => [String(f.id), f]));
      return {
        original: String(a.id),
        partes: ids.map((id, k) => ({ id, parte: k + 1, de: ids.length, amount_assigned: Number(porPago.get(id)?.amount_assigned ?? partes[k].importe), bank_account_id: porPago.get(id)?.bank_account_id ?? origenes[k] })),
      };
    });
  }

  /**
   * `[PGP.46]` El proveedor del catálogo detrás de un pago, o `null`.
   *
   * La asignación no guarda el proveedor: guarda los renglones de deuda que cubre. Para la deuda
   * del ERP la llave es el `md5` de `(sucursal, tipo, subtipo, folio)` — la misma que arma
   * `sqlKeplerPayableId`, no una copia — y de ahí se resuelve el código Kepler contra
   * `catalog.suppliers`.
   *
   * ⛔ Devuelve `null` sin ruido cuando no se puede resolver: un pago puede cubrir un gasto o un
   * compromiso financiero, que no tienen proveedor de catálogo, y una factura ya saldada sale de
   * `v_supplier_payables` (es lo que midió `[PGP.40]`). Inventar un proveedor para colgarle una
   * cuenta bancaria sería mucho peor que no registrarla.
   */
  private async proveedorDeAllocation(trx: Knex.Transaction, tenantId: string, allocationId: string): Promise<string | null> {
    const row = await trx('finance.payment_allocation_items as i')
      .join('analytics.v_supplier_payables as v', trx.raw(`${KEPLER_PAYABLE_ID} = i.obligation_id`))
      .join('catalog.suppliers as s', 's.code', 'v.proveedor')
      .where('i.allocation_id', allocationId)
      .andWhere('v.tenant_id', tenantId)
      .select('s.id')
      .first();
    return (row as { id?: string } | undefined)?.id ?? null;
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

  /**
   * `[PGP.105]` El ensayo del pago en Kepler: lo que se escribiría y, si Tesorería ya lo capturó, la
   * comparación. Sólo lectura (la réplica `kepler_ods`, nunca el Kepler vivo).
   */
  async ensayoKepler(allocationId: string): Promise<PaymentCalendarEnsayoKepler> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const r = await leerEnsayoPagoKepler(trx, tenantId, allocationId, todayMx());
      if (!r) throw new NotFoundException('Pago no encontrado');
      return r;
    });
  }

  /**
   * `[PGP.125]` Si la Suite escribe sola el `X-D-26` y en qué servidores: la misma llave y las mismas plantillas que
   * lee el worker que escribe (`PagosPorElBancoService`), más el último que escribió. Es lo que la pantalla dice en
   * vez de la frase fija que afirmaba «apagada». Sólo lectura.
   */
  async escrituraKepler(): Promise<PaymentCalendarEscrituraKepler> {
    const tenantId = this.tenantCtx.requireTenantId();
    const env = process.env;
    const servidores = Array.from({ length: 9 }, (_, i) => `0${i}`).filter((nn) => plantillaPagoDe(nn, env).ok);
    const ultimo = await this.tk.run(async (trx) => trx('finance.payment_allocations')
      .where({ tenant_id: tenantId, kepler_payment_linked_by: AUTOR_PAGO_POR_EL_BANCO })
      .whereNotNull('kepler_payment_folio')
      .orderBy('kepler_payment_linked_at', 'desc')
      .first('kepler_payment_sucursal', 'kepler_payment_folio', 'kepler_payment_linked_at'));
    return {
      encendida: escrituraDePagoEncendida(env),
      servidores,
      ultimo: ultimo ? { sucursal: String(ultimo.kepler_payment_sucursal), folio: String(ultimo.kepler_payment_folio), at: new Date(ultimo.kepler_payment_linked_at).toISOString() } : null,
    };
  }

  /**
   * Marca el pago como pagado. `[PGP.107]` (F2, Edgar 2026-11-09): sólo si lo prueban la salida del
   * estado de cuenta y su comprobante (`validarPagos`), y guarda esa evidencia en el pago — de ahí
   * salen el `X-D-26` de Kepler y la póliza de ContPAQi. El efectivo se valida a mano por ahora (la
   * ventanilla sólo deja rastro después de Kepler, `[PGP.102]`). `hoy` sólo lo fijan las pruebas.
   */
  async execute(allocationId: string, username: string, hoy: string = todayMx()): Promise<AllocationRowLite> {
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
      // `[PGP.113]` Se autoriza el PAGO, no el día. Un día autorizado completo con la regla vieja
      // (`releaseLot`) sigue valiendo para sus pagos.
      const execLot = await trx('finance.payment_calendar_lots').where({ id: allocation.lot_id }).first();
      if (!allocation.authorized_at && (!execLot || !LOCKED_LOT_STATUSES.has(execLot.status))) {
        throw new BadRequestException('Este pago todavía no está autorizado: Dirección lo autoriza antes de marcarlo pagado.');
      }
      // `[TP.15]` Entre asignar y ejecutar pueden pasar días: si Kepler ya no debe la factura, no se paga.
      await this.assertFacturasVigentes(trx, tenantId, allocationId);
      // `[PGP.107]` La evidencia: va DESPUÉS del saldo de Kepler (un pago que Kepler ya no debe se
      // rechaza por eso, no por falta de banco).
      const { rows: [{ dia }] } = await trx.raw(`SELECT to_char(lot_date, 'YYYY-MM-DD') AS dia FROM finance.payment_calendar_lots WHERE id = ?`, [allocation.lot_id]);
      const v: ValidacionPago | undefined = (await leerValidacionDelDia(trx, tenantId, dia, hoy)).get(allocationId);
      if (!v || (v.estado !== 'validado' && v.estado !== 'efectivo_no_medido')) {
        throw new BadRequestException(`No se puede marcar pagado sin la prueba de que salió: ${v?.motivo ?? 'el día del pago todavía no llega.'}`);
      }
      let evidencia: Record<string, unknown> = {};
      if (v.estado === 'validado') {
        const mov = await trx('finance.bank_movements').where({ id: v.movimiento_id }).first('movement_date', 'amount_out');
        evidencia = {
          paid_bank_movement_id: v.movimiento_id, paid_proof_id: v.comprobante_id,
          paid_bank_date: mov?.movement_date ?? null, paid_bank_amount: mov?.amount_out ?? null, paid_validated_at: trx.fn.now(),
        };
      }
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId })
        .update({ status: 'executed', executed_at: trx.fn.now(), updated_by: username, updated_at: trx.fn.now(), ...evidencia }).returning('*');
      await this.aplicarRenglonesPagados(trx, tenantId, allocationId, username);
      return updated;
    });
  }

  /**
   * Lo que pagar le hace a cada renglón: recalcula su obligación y, si es un gasto del presupuesto, mueve la
   * partida. `[PGP.121]` Salió de `execute()` para que el pago que prueba el banco haga EXACTAMENTE lo mismo.
   */
  private async aplicarRenglonesPagados(trx: Knex.Transaction, tenantId: string, allocationId: string, username: string): Promise<void> {
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
  }

  /**
   * `[TP.15]` Kepler todavía debe cada factura del pago (se mide al autorizar y al marcar pagado).
   * `[PGP.113]` Era un ciclo dentro de `execute()`; salió aquí para que autorizar diga lo mismo ANTES
   * de que Dirección firme algo que el ERP ya no debe.
   */
  private async assertFacturasVigentes(trx: Knex.Transaction, tenantId: string, allocationId: string): Promise<void> {
    for (const it of (await trx('finance.payment_allocation_items').where({ allocation_id: allocationId })) as AllocationItemRow[]) {
      // `[TP.18]` Vale para los dos orígenes de factura. ⛔ Para el DERIVADO, además, que la
      // vista ya no traiga el documento significa que Kepler no lo debe: se trata igual que
      // saldo cero — no se ejecuta un pago contra una factura que el ERP ya no reconoce.
      if (it.obligation_source !== 'supplier_payable' && it.obligation_source !== 'kepler_payable') continue;
      const row = await this.loadObligationRow(trx, tenantId, it.obligation_source, it.obligation_id);
      // `[PGP.91]` Al EJECUTAR se mide lo CUBIERTO (neto + descuento), con UNA excepción: si la
      // nota de crédito del descuento llegó a Kepler antes que la transferencia, el pendiente ya
      // ES el neto (±1 centavo) y el pago es correcto. Medir sólo el neto dejaba pasar de más:
      // con otra nota ajena aplicada, el neto cabía y al llegar la del descuento quedaba sobrepagado.
      const discount = Number(it.discount_amount ?? 0);
      if (row) await this.assertKeplerBalance(trx, it.obligation_source, row, Number(it.applied_amount) + discount, 0,
        discount > 0 ? Number(it.applied_amount) : undefined);
      else if (it.obligation_source === 'kepler_payable') {
        throw new BadRequestException('Kepler ya no tiene saldo pendiente de esta factura (¿se pagó por fuera o tiene nota de crédito?). No se programa ni se ejecuta.');
      }
    }
  }

  /**
   * `[PGP.113]` **Se autoriza el PAGO, no el día** (Edgar, 2026-11-10: «haremos una a una»).
   *
   * Hasta hoy Dirección firmaba el DÍA (`releaseLot`) y sólo con TODOS sus pagos preparados y
   * ordenados: un pago sin preparar frenaba a los demás. Medido en prod el 2026-11-10: 37 días
   * armados, los 37 en borrador; **ningún día se autorizó nunca**.
   *
   * Lo que se exige, pago por pago:
   *  · pendiente, preparado (`isPrepared`: método, origen y destino) y sin autorizar;
   *  · su día tiene tope de Presupuestos, y **cabe**: lo ya autorizado o pagado ese día + éste ≤ tope.
   *    El tope se cuida al autorizar porque es cuando el dinero queda comprometido; el lote del día
   *    se bloquea (`FOR UPDATE`) para que dos autorizaciones al mismo tiempo no quepan las dos;
   *  · Kepler todavía debe sus facturas (el mismo candado que al marcar pagado).
   * Le pone su folio (`AAMMDD-01-NN`, el del día con su número) si no tiene: es el que imprime la
   * instrucción de pago. ⛔ No se exige ORDEN: el orden del día sólo servía para liberar el día.
   *
   * NO MEDIDO / NO IMPUESTO: que quien autoriza no sea quien armó (igual que con el día; se dice en
   * pantalla, no se bloquea). Es decisión de Edgar.
   */
  async authorize(allocationId: string, username: string): Promise<AllocationRowLite> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).forUpdate().first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se autoriza un pago pendiente');
      if (allocation.authorized_at) throw new BadRequestException(`Este pago ya lo autorizó ${allocation.authorized_by ?? 'Dirección'}.`);
      if (!isPrepared(allocation)) throw new BadRequestException('Falta prepararlo (método, cuenta de origen y destino) antes de autorizarlo.');
      const { rows: [lot] } = await trx.raw(
        `SELECT id, status, folio, to_char(lot_date, 'YYYY-MM-DD') AS dia FROM finance.payment_calendar_lots WHERE id = ? FOR UPDATE`, [allocation.lot_id]);
      if (!lot) throw new NotFoundException('El día del pago no existe');
      if (LOCKED_LOT_STATUSES.has(lot.status)) throw new BadRequestException('El día de este pago ya se autorizó completo.');
      const capacity = await trx('budget.daily_capacity').where({ tenant_id: tenantId, capacity_date: lot.dia }).first();
      if (!capacity) throw new BadRequestException(`El ${lot.dia} no tiene tope de Presupuestos: no se puede autorizar (pide el tope o mueve el pago a un día que lo tenga).`);
      const { rows: [{ comprometido }] } = await trx.raw(
        `SELECT coalesce(sum(amount_assigned), 0)::float8 AS comprometido FROM finance.payment_allocations
          WHERE lot_id = ? AND id <> ? AND (status = 'executed' OR (status = 'pending' AND authorized_at IS NOT NULL))`, [lot.id, allocationId]);
      const tope = Number(capacity.authorized_amount);
      const monto = Number(allocation.amount_assigned);
      if (Number(comprometido) + monto > tope + 0.005) {
        throw new BadRequestException(`No cabe en el tope del ${lot.dia}: ya hay ${PESOS_MX.format(Number(comprometido))} autorizados o pagados de ${PESOS_MX.format(tope)} y este pago es de ${PESOS_MX.format(monto)} (faltan ${PESOS_MX.format(Number(comprometido) + monto - tope)}).`);
      }
      await this.assertFacturasVigentes(trx, tenantId, allocationId);
      let folio: string | null = allocation.folio ?? null;
      if (!folio) {
        const prefijo = lot.folio || `${lot.dia.replace(/-/g, '').slice(2)}-01`;
        const usados = (await trx('finance.payment_allocations').where({ lot_id: lot.id }).whereNotNull('folio').select('folio')) as { folio: string }[];
        const max = usados.map((u) => Number(u.folio.split('-').pop())).filter((n) => Number.isFinite(n)).reduce((m, n) => Math.max(m, n), 0);
        folio = `${prefijo}-${String(max + 1).padStart(2, '0')}`;
      }
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId })
        .update({ authorized_by: username, authorized_at: trx.fn.now(), folio, updated_by: username, updated_at: trx.fn.now() }).returning('*');
      return updated;
    });
  }

  /**
   * `[PGP.113]` Quitarle la autorización a un pago que todavía no se marca pagado (para cambiarlo, o
   * porque no debía salir). Queda en las notas quién y por qué. Conserva su folio.
   */
  async unauthorize(allocationId: string, reason: string | undefined, username: string): Promise<AllocationRowLite> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).forUpdate().first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se le quita la autorización a un pago pendiente (uno pagado ya salió).');
      if (!allocation.authorized_at) throw new BadRequestException('Este pago no está autorizado.');
      const nota = `[autorización quitada por ${username}${reason?.trim() ? `: ${reason.trim()}` : ''}; la había dado ${allocation.authorized_by ?? '—'}]`;
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId }).update({
        authorized_by: null, authorized_at: null, notes: `${allocation.notes ?? ''}\n${nota}`.trim(),
        updated_by: username, updated_at: trx.fn.now(),
      }).returning('*');
      return updated;
    });
  }

  /**
   * `[PGP.199]` **Antes de cancelar, marcar fallido o reprogramar: ¿ya salió el dinero?** Si el banco (sin devueltas, sin
   * las salidas de otros pagos, o varias con la misma referencia) o Kepler (todas sus facturas pagadas con dinero) lo
   * prueban, se niega con lo que se vio; una persona sigue sólo diciendo por qué esa salida no es de este pago
   * (`aunqueSalio`), y queda en la bitácora con la evidencia. La regla es pura (`motivoParaNoCambiar`).
   */
  private async assertNoSalio(
    trx: Knex.Transaction, tenantId: string, allocation: { id: string; lot_id: string; amount_assigned: string | number; created_at: Date | string },
    accion: AccionSobreElPago, username: string, aunqueSalio?: string, hoy: string = todayMx(),
  ): Promise<void> {
    const lot = await trx('finance.payment_calendar_lots').where({ id: allocation.lot_id })
      .first(trx.raw("to_char(lot_date, 'YYYY-MM-DD') AS dia")) as { dia: string } | undefined;
    if (!lot) return;
    const desde = new Date(Date.parse(`${lot.dia}T12:00:00Z`) - DIAS_ANTES * 86_400_000).toISOString().slice(0, 10);
    const salida = desde <= hoy
      ? ((await trx.raw(SQL_SALIDA_QUE_LO_PAGO, [tenantId, Number(allocation.amount_assigned), lot.dia, hoy, allocation.id])).rows as SalidaQueLoPago[])[0] ?? null
      : null;
    const items = (await trx('finance.payment_allocation_items').where({ tenant_id: tenantId, allocation_id: allocation.id })
      .select('allocation_id', 'obligation_source', 'obligation_id')) as ItemParaCierre[];
    const alta = new Date(allocation.created_at).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const cierre = items.length ? (await this.cierresKepler(trx, [{ id: allocation.id, lotDate: lot.dia, alta }], items)).get(allocation.id) : null;
    const motivo = motivoParaNoCambiar(accion, salida, cierre);
    if (!motivo) return;
    if (!motivoAunqueSalioValido(aunqueSalio)) throw new ConflictException(motivo);
    await trx('finance.payment_allocation_history').insert({
      tenant_id: tenantId, allocation_id: allocation.id, event: EVENTO_AUNQUE_SALIO, created_by: username,
      detail: JSON.stringify({ regla: 'PGP.199', accion, motivo_de_la_persona: aunqueSalio!.trim(), lo_que_se_vio: motivo, banco: salida ?? null,
        kepler: cierre ? { estado: cierre.estado, pagos: cierre.pagos.map((p) => `${p.doc_prefix}-${p.folio}`) } : null }),
    });
  }

  async fail(allocationId: string, reason: string | undefined, username: string, aunqueSalio?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se marca como fallido un pago pendiente (uno ejecutado no se revierte acá)');
      await this.assertNoSalio(trx, tenantId, allocation, 'marcar como fallido', username, aunqueSalio);
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId })
        .update({ status: 'failed', failure_reason: reason ?? null, updated_by: username, updated_at: trx.fn.now() }).returning('*');
      const items = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId });
      for (const it of items as any[]) await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      return updated;
    });
  }

  async cancelAllocation(allocationId: string, reason: string | undefined, username: string, aunqueSalio?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se puede cancelar un pago pendiente');
      await this.assertNoSalio(trx, tenantId, allocation, 'cancelar', username, aunqueSalio);
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
              WHEN 'kepler_payable' THEN kv.vencimiento END) AS min_due,
            -- [PGP.37] Lo que este pago GANA si sale hoy. Solo cuenta la ventana ABIERTA: lo que
            -- ya se paso no gana nada por adelantarse, y ponerlo aqui subiria un renglon que no
            -- va a cobrar el descuento.
            coalesce(sum(CASE WHEN pp.pronto_estado IN ('capturable','por_vencer')
                              THEN pp.pronto_beneficio ELSE 0 END), 0) AS pronto_en_juego
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
          -- [PGP.37] El descuento en juego entra en el ORDEN. La regla NO se reimplementa: sale
          -- de sqlVentanaProntoPago(), igual que en la pantalla. Un segundo criterio de "hasta
          -- cuando conviene pagar" ordenaria el dia por una fecha que el renglon no muestra.
          LEFT JOIN analytics.mv_supplier_prompt_discount kd
                 ON btrim(kd.proveedor_code) = btrim(kv.proveedor)
          LEFT JOIN LATERAL (SELECT ${sqlVentanaProntoPago('kv', 'kd')}) pp ON true
          WHERE a.lot_id = ? AND a.status = 'pending'
          GROUP BY a.id
        )
        SELECT a.id, a.classification, coalesce(c.any_critical,false) AS any_critical, c.min_due, c.pronto_en_juego, a.amount_assigned
        FROM finance.payment_allocations a JOIN crit c ON c.allocation_id = a.id
        ORDER BY
          CASE a.classification WHEN 'compromiso_financiero' THEN 0 WHEN 'gasto' THEN 1 WHEN 'proveedor_mercancia' THEN 2 ELSE 3 END,
          c.any_critical DESC,
          -- [PGP.37] El descuento manda DENTRO de su clase, nunca por encima: un compromiso
          -- financiero o un acreedor critico no se postergan por ganar un descuento. Medido
          -- 2026-10-29: hay $2,427,564 con ventana abierta sobre la deuda viva, y el orden
          -- anterior no lo miraba -- el corte por capacidad dejaba fuera renglones que SI
          -- cobraban y adentro otros que no.
          c.pronto_en_juego DESC,
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

  /**
   * `[PGP.76]` **El orden del día entero, en UNA escritura.** Tesorería arrastra un pago (o lo
   * mueve con el teclado) y la pantalla manda la lista completa de pendientes en su nuevo orden.
   * Antes cada paso de las flechas eran tres `setPriorityRank` seguidos y una recarga: llevar el
   * pago 20 al turno 1 costaba 19 clics y 57 escrituras (234 `POST …/orden` en 30 días, 71 con 4xx,
   * medido el 2026-11-05). Aquí no hay choque posible: todos los turnos cambian en la misma
   * sentencia, y si la lista no es exactamente la de pendientes del día —otra persona agregó o
   * quitó un pago mientras se ordenaba— se rechaza entera en vez de dejar un orden a medias.
   */
  async reorderDay(date: string, ids: readonly string[], username: string): Promise<DayOrderRank[]> {
    this.assertDate(date);
    if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string' || !x)) {
      throw new BadRequestException('ids debe ser la lista de pagos pendientes del día en su nuevo orden');
    }
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Un pago aparece dos veces en el orden');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).forUpdate().first();
      if (!lot) throw new NotFoundException('No hay pagos asignados este día');
      if (lot.status !== 'draft' && lot.status !== 'scheduled' && lot.status !== 'in_prep') {
        throw new BadRequestException(`El día ya está en estado "${lot.status}": su orden de pago ya no cambia`);
      }
      const pend: Array<{ id: string }> = await trx('finance.payment_allocations').where({ lot_id: lot.id, status: 'pending' }).select('id');
      const vivos = new Set(pend.map((r) => r.id));
      if (pend.length !== ids.length || ids.some((id) => !vivos.has(id))) {
        throw new ConflictException('Los pagos del día cambiaron mientras los ordenabas: recarga y vuelve a moverlo');
      }
      await trx.raw(`
        UPDATE finance.payment_allocations a
           SET priority_rank = v.r::int, updated_by = ?, updated_at = now()
          FROM unnest(?::uuid[]) WITH ORDINALITY AS v(id, r)
         WHERE a.id = v.id AND a.lot_id = ? AND a.priority_rank IS DISTINCT FROM v.r::int`, [username, ids, lot.id]);
      return ids.map((id, i) => ({ id, priority_rank: i + 1 }));
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
