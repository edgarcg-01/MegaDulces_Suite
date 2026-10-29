/**
 * `[TP.16]` Calendario de Pagos — vista semanal y «Ordenar y pagar».
 *
 * Forma de lo que ya devolvían `days/:date/summary` y `days/:date/allocations` (TP.1), ahora con
 * nombre en contratos, más la semana completa y las cuentas de ORIGEN (`finance.bank_accounts`).
 */

/**
 * `[TP.18]` `kepler_payable` es la deuda viva de Kepler que NO pasó por Entregas de Compras
 * (servicios, fletes, toda factura sin capturar). No tiene tabla propia: se deriva de
 * `analytics.v_supplier_payables` y su `obligation_id` es un uuid determinístico (ADR-094).
 */
export type PaymentObligationSource = 'budget_expense' | 'financial_commitment' | 'supplier_payable' | 'kepler_payable';
export type PaymentMethod = 'transferencia' | 'cheque' | 'efectivo' | 'cargo_automatico';

export interface PaymentCalendarDaySummary {
  date: string;
  /** `false` = Presupuestos no fijó capacidad ese día (distinto de capacidad CERO). */
  capacity_defined: boolean;
  authorized_amount: number | null;
  assigned_amount: number;
  remaining_amount: number | null;
  executed_amount: number;
  pending_execution_amount: number;
  exceeded: boolean;
  /** `draft | scheduled | in_prep | released | executing | closed`, o null sin pagos. */
  lot_status: string | null;
}

export interface PaymentCalendarAllocationItem {
  id: string;
  obligation_source: PaymentObligationSource;
  obligation_id: string;
  applied_amount: number;
  beneficiary: string;
  concept: string;
  supplier_id: string | null;
  /** `[TP.16.3]` Sucursal (centro de costo) de la factura; null fuera de facturas de proveedor. */
  branch_code: string | null;
}

export interface PaymentCalendarAllocation {
  id: string;
  classification: string;
  priority_rank: number | null;
  amount_assigned: number;
  status: string;
  payment_method: PaymentMethod | null;
  /** Cuenta de ORIGEN (la nuestra, de donde sale el dinero). */
  bank_account_id: string | null;
  /** `[TP.16]` Alias legible de la cuenta de origen (p. ej. «BBVA 6721»); null si no se eligió. */
  bank_account_label: string | null;
  /** Cuenta DESTINO: snapshot del catálogo del proveedor, o texto capturado. */
  destination_account_text: string | null;
  cash_register_text: string | null;
  reference_text: string | null;
  notes: string | null;
  failure_reason: string | null;
  folio: string | null;
  supplier_payment_account_id: string | null;
  items: PaymentCalendarAllocationItem[];
}

/**
 * `[TP.21.1]` **Lo que el libro de Tesorería dice de ESE día.**
 *
 * El Calendario y el *Programa de pagos* no son dos temas: son **la misma línea de tiempo** —el
 * día en que sale el dinero— cortada en dos, con el pasado en un Excel y el futuro en el sistema.
 * Medido el 2026-10-20: el libro llega hasta el **2026-08-28** y el calendario empieza el
 * **2026-10-16**; **0 días en común** y **53 días** en medio de los que ninguna de las dos
 * pantallas dice nada.
 *
 * ⛔ Esto **no casa renglones**: el libro no guarda el folio del pago de Kepler, y casar por
 * monto+mes es lo que produjo los $273 M indefendibles de `[PP.4]`. Acá sólo se **suma por
 * fecha**, que es la única llave que las dos comparten de verdad.
 */
export interface PaymentCalendarDayBook {
  /**
   * Lo que el **ERP** registra que salió ese día. `[PGP.9]` cambió la fuente: era el Excel de
   * Tesorería y pasó a `analytics.erp_supplier_payments`.
   *
   * ⭐ El motivo, medido el 2026-10-24: el Excel llevaba **77 días sin cargarse**, y cuando
   * estaba vivo ya cubría un tercio —agosto: **157 pagos / $17.9 M** en el libro contra
   * **530 / $45.2 M** en el ERP—. Un testigo que alguien carga a mano no es un testigo.
   */
  monto: number;
  n: number;
  /**
   * ⚠️ Cuándo se recalculó por última vez el espejo del ERP, en ISO. **Sin esto, un `0` no se
   * puede leer**: con el espejo fresco significa «no se pagó» (un sábado); con el espejo viejo
   * significa «no sabemos». Es la misma lección que la bandera anterior —`mes_cargado`— movida
   * al eje que corresponde ahora que la fuente llega sola. `null` = no hay con qué fecharlo.
   */
  data_as_of: string | null;
}

export interface PaymentCalendarWeekDay {
  date: string;
  summary: PaymentCalendarDaySummary;
  allocations: PaymentCalendarAllocation[];
  lot_folio: string | null;
  /** `[TP.21.1]` El pasado de este mismo día, según el libro. `null` = no se pudo medir. */
  libro?: PaymentCalendarDayBook | null;
}

export interface PaymentCalendarWeek {
  /** Lunes de la semana (YYYY-MM-DD). */
  from: string;
  /** Domingo de la semana (YYYY-MM-DD). */
  to: string;
  days: PaymentCalendarWeekDay[];
}

/** `[TP.16]` Cuenta de origen elegible para un pago (activa, banco o factoraje; nunca la caja). */
export interface PaymentOriginAccount {
  id: string;
  bank: string;
  account_label: string;
  alias: string | null;
  kind: string;
}

/**
 * `[PGP.19]` La MEJOR prueba documental de un documento por pagar, salga de donde salga.
 *
 * No es un carril: es el resultado de puntuar todos los candidatos (papel adjunto en Compras +
 * CFDI recibido) por cuántas de las 5 señales coinciden —importe, fecha, folio, referencia,
 * RFC— exigiendo siempre un ancla (importe o RFC) y un puntaje mínimo de 3.
 *
 * Medido contra prod el 2026-10-27 sobre 2,917 documentos exigibles: 774 con PDF del proveedor,
 * 367 con sólo UUID fiscal, 1,776 sin nada. Placebo del umbral 3 = 0 (precisión 100%); bajar a
 * umbral 2 sube la cobertura a 59.7% pero el placebo salta a 958, o sea 45% de precisión.
 */
export interface PayableEvidenceRow {
  /**
   * `oblig:<sucursal>|<doc_tipo>|<doc_sub>|<folio>` — la MISMA llave que trae cada obligación en
   * su `entity_ref`. Es lo que deja pegar la evidencia al renglón sin rearmar la clave natural.
   */
  entity_ref: string;
  sucursal: string;
  doc_tipo: string;
  doc_sub: string;
  folio: string;
  proveedor: string;
  pendiente: number;
  /** `pdf` = el documento de verdad · `uuid` = sólo el identificador fiscal, sin archivo. */
  evidencia: 'pdf' | 'uuid' | 'ninguna';
  /** Id del comprobante en `finance.goods_receipt_proofs` (pdf) o UUID del CFDI (uuid). */
  ref_evidencia: string | null;
  /** 3 a 5. Cuántas señales independientes coincidieron. */
  puntaje: number;
  /** Las señales que coincidieron, para poder explicar en pantalla POR QUÉ es ésta. */
  senales: string[];
  /** Por qué no hay evidencia. `null` cuando sí la hay. Nunca se deja el hueco mudo (ADR-056). */
  motivo: string | null;
  /**
   * `[PGP.27]` El RFC del acreedor con el que se buscó, y **de dónde salió**.
   *
   * ⛔ No es cosmético: `nombre` quiere decir que Kepler **no** lo tiene (o lo tiene mal
   * escrito) y lo resolvió un cruce del nombre normalizado contra ContPAQi y los CFDI
   * recibidos. Son 166 documentos por $10,415,534 que antes no encontraban su factura, y la
   * pantalla no puede presentarlos como si el dato viniera del ERP (ADR-056).
   */
  rfc: string | null;
  rfc_fuente: 'kepler' | 'nombre' | 'ninguna';
  /**
   * `[PGP.32]` (ADR-108) **Lo que Kepler tiene capturado, cuando CONTRADICE al comprobante
   * timbrado.** `null` es el caso normal — y también cuando Kepler simplemente no lo tiene o lo
   * tiene mal escrito, que es otra cosa y ya la dice `rfc_fuente`.
   *
   * ⛔ Sin esta columna, `rfc_fuente === 'nombre'` tapaba dos situaciones distintas y el rótulo
   * de la pantalla afirmaba la equivocada: desde `[PGP.31]` el nombre también gana cuando Kepler
   * SÍ tiene un RFC bien formado. Son **18 acreedores · 91 documentos**, J&F y MONDELEZ entre
   * ellos. Decir «Kepler no tiene un RFC utilizable» ahí sería falso.
   */
  rfc_discrepa: string | null;
}

/**
 * `[PGP.21]` Un archivo de evidencia, ya firmado y listo para abrir.
 *
 * ⛔ Lo sirve el módulo de Pagos con `FINANCE_PAYMENTS_VER`, NO el de Compras. Medido el
 * 2026-10-27: de los 32 roles que ven Pagos, 3 no tienen `COMPRAS_ENTRADAS_VER`
 * (`finanzas_operativo`, `contabilidad`, `auditor_externo`) — y el primero es Tesorería.
 * Enlazar al endpoint de Compras les habría dado 403 justo a quien paga.
 */
export interface PayableEvidenceFile {
  /** URL prefirmada, de vida corta. No se guarda ni se comparte: se vuelve a pedir. */
  url: string;
  name: string | null;
  /** `factura`, `orden_entrada`, `remision`… — el papel que es. */
  role: string | null;
  kind: string | null;
}

/**
 * `[PGP.30]` **Con qué se le suele pagar a este acreedor.** Propone, no decide.
 *
 * El Calendario pedía método y cuenta de origen a mano, pago por pago. Medido contra prod el
 * 2026-10-28 sobre 4,881 pagos de 316 acreedores: el método es **transferencia en el 92.6 %**,
 * **288 de 316 acreedores (91.1 %)** tienen uno estable, y **250 de 282 (88.7 %)** repiten el del
 * pago anterior.
 *
 * ⛔ **Nada se aplica solo.** La propuesta llega precargada y editable, y viaja con su evidencia
 * (`veces` de `de`, y cuándo fue la última) para que quien paga pueda contradecirla de un vistazo.
 * Un número sin con qué discutirlo no es una propuesta, es una orden disfrazada.
 */
export interface SupplierPaymentHabit {
  /** `catalog.suppliers.id` — la llave con la que el Calendario nombra al beneficiario. */
  supplier_id: string;
  proveedor_code: string;

  /**
   * `estable` trae `metodo_sugerido`; `variable` y `sin_historial` NO proponen.
   *
   * ⛔ Nunca vale `efectivo` ni `cargo_automatico`: Kepler (`kdm1.c31`) no los distingue, así que
   * **la ausencia de propuesta no es evidencia de que no se usen**.
   */
  metodo_estado: 'estable' | 'variable' | 'sin_historial';
  metodo_sugerido: PaymentMethod | null;
  metodo_veces: number | null;
  metodo_de: number | null;
  metodo_ultima_vez: string | null;

  /**
   * `estable` trae `cuenta_origen_id`. Los otros tres explican por qué no, y cada uno dice algo
   * distinto:
   *
   * - `caja_general` — se le suele pagar **desde Caja General**, que el selector de origen no
   *   ofrece («la caja no es origen de una transferencia»). Son **116 de 316**: el dato más útil
   *   del grupo, porque hoy no aparece en ninguna pantalla.
   * - `no_resuelve` — la cuenta existe en Kepler pero no casa con ninguna del catálogo propio
   *   (13 acreedores; `BAJIO 6506` y `BAJIO 5854` difieren en un dígito de las nuestras).
   * - `variable` — paga desde varias y ninguna llega al piso.
   */
  cuenta_estado: 'estable' | 'variable' | 'caja_general' | 'no_resuelve' | 'sin_historial';
  cuenta_origen_id: string | null;
  cuenta_origen_nombre: string | null;
  cuenta_veces: number | null;
  cuenta_de: number | null;
}
