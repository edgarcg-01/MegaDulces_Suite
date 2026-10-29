/**
 * `[TP.16.2]` Obligaciones disponibles del Calendario de Pagos, AGRUPADAS por beneficiario
 * (Francisco, 2026-10-16): un encabezado por proveedor (facturas, total, primer vencimiento) y
 * debajo sus facturas.
 *
 * - La clave incluye la CLASIFICACIÓN: el mismo nombre como gasto y como proveedor de mercancía no
 *   se mezcla, porque un pago no puede juntar clasificaciones (el backend lo rechaza).
 * - `[TP.16.3]` Y la SUCURSAL: un proveedor con facturas en 3 almacenes da 3 grupos, porque cada
 *   pago entra al centro de costo de su almacén (Francisco). El backend lo hace cumplir igual
 *   (`paymentGroupKey`).
 * - Orden: primero el proveedor que vence antes; dentro, la factura que vence antes. Sin fecha, al
 *   final. Los grupos del mismo proveedor quedan juntos (empate → nombre → sucursal).
 * - Sólo agrupa la VISTA: lo que se lista sigue siendo lo que el backend da como disponible
 *   (saldo > 0), así que lo que se quita de un día regresa aquí solo.
 */

export interface GroupableObligation {
  obligation_id: string;
  beneficiary: string;
  classification: string;
  concept: string;
  original_due_date: string | null;
  /** Fecha renegociada con el proveedor; si existe, manda sobre la original. */
  negotiated_date?: string | null;
  obligation_source?: string;
  /** Id del proveedor (sólo facturas de proveedor): dos proveedores pueden llamarse igual. */
  payee_id?: string | null;
  available_amount: number | string;
  is_critical: boolean;
  /** Sucursal (almacén) de la factura; null = sin sucursal (gasto, compromiso, captura manual). */
  branch_code?: string | null;
  /**
   * `[PGP.38]` La ventana de pronto pago, que el backend ya manda con cada obligación
   * (`sqlVentanaProntoPago`). Opcionales porque sólo la deuda derivada del ERP las trae.
   */
  pronto_fecha_limite?: string | null;
  pronto_beneficio?: number | string | null;
  pronto_estado?: string | null;
}

export interface ObligationGroup<T extends GroupableObligation> {
  kind: 'group';
  key: string;
  beneficiary: string;
  classification: string;
  /** Sucursal del grupo: un pago no junta sucursales (cada una es su centro de costo). */
  branch: string | null;
  count: number;
  total: number;
  firstDue: string | null;
  critical: boolean;
  items: T[];
}
export interface ObligationItemRow<T extends GroupableObligation> { kind: 'item'; key: string; o: T }
/** Proveedor con UNA sola factura: un renglón, sin encabezado (no se duplica la altura). */
export interface ObligationSingleRow<T extends GroupableObligation> { kind: 'single'; key: string; o: T; critical: boolean }
export type ObligationRow<T extends GroupableObligation> = ObligationGroup<T> | ObligationItemRow<T> | ObligationSingleRow<T>;

const NO_DATE = '9999-12-31';

/**
 * `[TP.16.4]` La llave de «un pago»: clasificación + beneficiario + sucursal. La misma para una
 * factura disponible y para un pago ya armado, así una factura nueva sabe a qué pago sumarse.
 * ⚠️ Es ESPEJO de `paymentGroupKey()` del backend (que es quien la hace cumplir): proveedor por su
 * id (dos proveedores pueden llamarse igual), los demás por nombre sin espacios y en mayúsculas, y
 * una sucursal vacía cuenta como «sin sucursal». Si cambia una, cambia la otra.
 */
const norm = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase();
const branchKey = (b: string | null | undefined) => String(b ?? '').trim() || '-';
function payeeKey(source: string | undefined, supplierId: string | null | undefined, beneficiary: string): string {
  // `[TP.18]` `kepler_payable` (la deuda derivada de Kepler, ADR-094) agrupa como factura: es del
  // mismo proveedor que una capturada y un pago puede cubrir las dos. Espejo del backend.
  const esFactura = source === 'supplier_payable' || source === 'kepler_payable';
  return esFactura && supplierId ? `s:${supplierId}` : `b:${norm(beneficiary)}`;
}
export function obligationKey(o: Pick<GroupableObligation, 'classification' | 'beneficiary' | 'branch_code' | 'obligation_source' | 'payee_id'>): string {
  return `${o.classification}|${payeeKey(o.obligation_source, o.payee_id, o.beneficiary)}|${branchKey(o.branch_code)}`;
}
export function allocationKey(a: { classification: string; items: { obligation_source?: string; supplier_id?: string | null; beneficiary: string; branch_code?: string | null }[] }): string {
  const it = a.items[0];
  return it ? `${a.classification}|${payeeKey(it.obligation_source, it.supplier_id, it.beneficiary)}|${branchKey(it.branch_code)}` : `${a.classification}|∅`;
}
/** Vencimiento que manda: el NEGOCIADO si lo hay (una factura renegociada no está vencida). */
export function vencimiento(o: Pick<GroupableObligation, 'original_due_date' | 'negotiated_date'>): string | null {
  return (o.negotiated_date ?? o.original_due_date)?.slice(0, 10) ?? null;
}

export interface ArmadoGrupo<T extends GroupableObligation> {
  key: string; beneficiary: string; branch: string | null; items: T[]; total: number;
  /** Vencimiento de la factura más vieja del grupo. */
  oldest: string;
  /** Cabe en lo que queda del disponible, en el orden propuesto. */
  fits: boolean;
  /**
   * `[PGP.38]` **Por qué este grupo está en la propuesta.** `vencida` es la regla de siempre;
   * `pronto_pago` es la que faltaba: una factura que **todavía no vence** pero cuya ventana de
   * descuento cierra pronto. Sin ella la propuesta automática no podía capturar el pronto pago,
   * porque el pronto pago **consiste en adelantarse**.
   */
  motivo: 'vencida' | 'pronto_pago';
  /** Lo que el grupo gana si se paga en este día (0 si no hay ventana abierta medida). */
  gana: number;
}

/**
 * `[TP.16.4]` «Sugerir armado» de un día (Francisco revisó la regla en la maqueta, 2026-10-16):
 *  1. toma lo VENCIDO o que vence ese día;
 *  2. un pago por proveedor + sucursal;
 *  3. primero el grupo con la factura más vieja; empate → el de mayor monto;
 *  4. llena hasta `room` (el disponible del día); lo que no cabe se marca `fits: false`.
 * Sin fecha de vencimiento no entra: no se puede decir que ya venció.
 *
 * ⭐⭐ `[PGP.38]` **Y lo que NO vence todavía pero pierde descuento si se espera.** La regla
 * original decía *«nunca lo que vence después: eso no se adelanta solo»*, y era razonable —
 * adelantar dinero sin motivo es un costo. Pero **el pronto pago consiste exactamente en
 * adelantarse**, así que esa regla le ponía un techo a la automatización.
 *
 * Medido contra prod el 2026-10-29, sobre $139.6M de deuda viva:
 *
 *   | | facturas | deuda | descuento con ventana ABIERTA |
 *   |---|---:|---:|---:|
 *   | ya vencida (la regla sí la tomaba) | 2,558 | $94,318,131 | $910,762 |
 *   | vence después (**no** la tomaba)   |   358 | $45,495,043 | **$1,522,587** |
 *
 * O sea que **el 62.7 % del descuento en juego estaba fuera del alcance de la propuesta**, y
 * justo donde vive el pronto pago: una factura dentro de su ventana, por definición, todavía
 * no vence.
 *
 * ⛔ Entra **sólo** si se dan las dos: su ventana cierra dentro de `DIAS_ADELANTO` **y** el
 * beneficio medido es > 0. Adelantar sin descuento medido sería sacar dinero antes por nada.
 * ⛔ Y el motivo viaja en el grupo: la pantalla **tiene que decir** que esto se adelanta y por
 * cuánto. Una propuesta que mete una factura no vencida sin explicarlo es un cambio de criterio
 * a espaldas de quien firma.
 * ⛔ El orden NO cambia de fondo: **lo vencido va primero**, así que si el disponible no alcanza,
 * lo que se recorta es el adelanto y nunca la deuda que ya se debe.
 */
/**
 * Días de anticipación con que se ofrece adelantar un pago por su descuento. Es el mismo margen
 * de aviso que usa la pantalla (`PRONTO_PAGO_DIAS_AVISO`): si el renglón dice «por vencer», la
 * propuesta lo ofrece. Dos números distintos harían que la pantalla avisara de algo que el
 * armado ignora.
 */
export const DIAS_ADELANTO = 5;

export function sugerirArmado<T extends GroupableObligation>(obligations: readonly T[], date: string, room: number): ArmadoGrupo<T>[] {
  const limiteAdelanto = sumarDias(date, DIAS_ADELANTO);
  /** `[PGP.38]` La ventana está abierta, cierra dentro del margen, y hay beneficio medido. */
  const adelantable = (o: T): boolean => {
    const lim = o.pronto_fecha_limite?.slice(0, 10) ?? null;
    return lim != null && lim >= date && lim <= limiteAdelanto && Number(o.pronto_beneficio ?? 0) > 0;
  };
  const due = obligations.filter((o) => {
    const d = dueOf(o);
    if (d != null && d <= date) return true;
    return adelantable(o);
  });
  const byKey = new Map<string, T[]>();
  for (const o of due) { const k = obligationKey(o); (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(o); }
  const groups = [...byKey.entries()].map(([key, items]) => {
    items.sort((a, b) => dueOf(a)!.localeCompare(dueOf(b)!));
    // `[PGP.38]` Un grupo es «vencida» si alguna de sus facturas ya venció. Si ninguna, está
    // entero por su descuento, y la pantalla tiene que decirlo.
    const hayVencida = items.some((o) => { const d = dueOf(o); return d != null && d <= date; });
    // El tipo se ANOTA: sin esto el ternario se infiere `string` y el objeto deja de ser un
    // `ArmadoGrupo<T>` (TS2322). `check:pantalla` lo daba por bueno — lo cazó
    // `check-template-types`, que es el único local que tipa de verdad la plantilla.
    const motivo: ArmadoGrupo<T>['motivo'] = hayVencida ? 'vencida' : 'pronto_pago';
    const gana = items.reduce((s, o) => s + Number(o.pronto_beneficio ?? 0), 0);
    return { key, beneficiary: items[0].beneficiary, branch: items[0].branch_code ?? null, items,
      total: items.reduce((s, o) => s + Number(o.available_amount), 0),
      // `oldest` sería null en un grupo que entró SÓLO por descuento: se usa el límite de su
      // ventana, que es la fecha que de verdad manda para ése.
      oldest: dueOf(items[0]) ?? items[0].pronto_fecha_limite?.slice(0, 10) ?? NO_DATE,
      fits: false,
      motivo,
      gana: Math.round(gana * 100) / 100 };
  }).sort((a, b) =>
    // Lo VENCIDO primero, siempre: el adelanto nunca desplaza una deuda que ya se debe.
    (a.motivo === b.motivo ? 0 : a.motivo === 'vencida' ? -1 : 1)
    || a.oldest.localeCompare(b.oldest) || b.total - a.total);
  let left = room;
  for (const g of groups) { g.fits = g.total <= left + 0.005; if (g.fits) left -= g.total; }
  return groups;
}
const dueOf = (o: GroupableObligation): string | null => vencimiento(o);

/** `[PGP.38]` Suma días a un `YYYY-MM-DD` sin arrastrar zona horaria. */
function sumarDias(iso: string, dias: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}

export function agruparObligaciones<T extends GroupableObligation>(obligations: readonly T[]): ObligationGroup<T>[] {
  const byKey = new Map<string, ObligationGroup<T>>();
  for (const o of obligations) {
    const branch = String(o.branch_code ?? '').trim() || null;
    const key = obligationKey(o);
    let g = byKey.get(key);
    if (!g) {
      g = { kind: 'group', key, beneficiary: o.beneficiary, classification: o.classification, branch, count: 0, total: 0, firstDue: null, critical: false, items: [] };
      byKey.set(key, g);
    }
    g.items.push(o);
    g.count++;
    g.total += Number(o.available_amount);
    g.critical = g.critical || o.is_critical;
    const due = dueOf(o);
    if (due && (!g.firstDue || due < g.firstDue)) g.firstDue = due;
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.items.sort((a, b) => (dueOf(a) ?? NO_DATE).localeCompare(dueOf(b) ?? NO_DATE));
  // El proveedor se ordena por SU primer vencimiento (de cualquier sucursal), para que sus grupos
  // por sucursal queden juntos; dentro, la sucursal que vence antes.
  const supplierFirst = new Map<string, string>();
  for (const g of groups) {
    const s = `${g.classification}|${g.beneficiary}`, d = g.firstDue ?? NO_DATE;
    if (!supplierFirst.has(s) || d < supplierFirst.get(s)!) supplierFirst.set(s, d);
  }
  const sf = (g: ObligationGroup<T>) => supplierFirst.get(`${g.classification}|${g.beneficiary}`) ?? NO_DATE;
  return groups.sort((a, b) => sf(a).localeCompare(sf(b)) || a.beneficiary.localeCompare(b.beneficiary)
    || (a.firstDue ?? NO_DATE).localeCompare(b.firstDue ?? NO_DATE) || (a.branch ?? '~').localeCompare(b.branch ?? '~'));
}

/**
 * Filas planas para la tabla. Proveedor con una factura → un solo renglón; con varias →
 * encabezado + sus facturas, salvo que esté plegado.
 */
export function filasAgrupadas<T extends GroupableObligation>(groups: readonly ObligationGroup<T>[], plegados: ReadonlySet<string>): ObligationRow<T>[] {
  const rows: ObligationRow<T>[] = [];
  for (const g of groups) {
    if (g.count === 1) { rows.push({ kind: 'single', key: g.key, o: g.items[0], critical: g.critical }); continue; }
    rows.push(g);
    if (!plegados.has(g.key)) for (const o of g.items) rows.push({ kind: 'item', key: `${g.key}|${o.obligation_id}`, o });
  }
  return rows;
}

/**
 * `[PGP.10]` **La fecha corta lleva AÑO cuando no es de este año.**
 *
 * ── Qué lo motiva ───────────────────────────────────────────────────────────────────────────
 * La columna «Vence» del Calendario formateaba siempre `{día, mes}`. En una lista de deuda eso
 * borra la diferencia entre lo que vence el mes que viene y lo que venció hace dos años.
 *
 * Medido contra prod el 2026-10-24: los **dos renglones que la pantalla pone primero** —los de
 * más monto y más vencidos— son «Nota cargo a proveedor» del **01/01/2025**, por **$8 M y $6 M**,
 * y se leían **«1 ene»**: igual que un vencimiento próximo. Son **$14.0 M** con forma de saldo de
 * apertura o préstamo a los socios (claves `AE*`, importes redondos), y Contabilidad todavía no
 * dictaminó qué son. Nadie debería poder programarlos creyendo que es deuda del mes.
 *
 * ⛔ El año va en **dos dígitos** a propósito: la columna vive en un panel angosto y ensancharla
 * empuja al resto. Lo que hace falta es distinguir el año, no escribirlo completo.
 *
 * `hoyIso` se recibe en vez de leer el reloj adentro: así la prueba fija el presente y no depende
 * del día en que se corra.
 */
export function fechaCorta(iso: string | null, hoyIso: string): string {
  if (!iso) return '—';
  const d = iso.slice(0, 10);
  const opts: Intl.DateTimeFormatOptions = d.slice(0, 4) === hoyIso.slice(0, 4)
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: '2-digit' };
  return new Date(d + 'T12:00:00Z').toLocaleDateString('es-MX', { ...opts, timeZone: 'UTC' });
}
