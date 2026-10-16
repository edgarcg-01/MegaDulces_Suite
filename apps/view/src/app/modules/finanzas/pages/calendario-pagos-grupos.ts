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
  return source === 'supplier_payable' && supplierId ? `s:${supplierId}` : `b:${norm(beneficiary)}`;
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
}

/**
 * `[TP.16.4]` «Sugerir armado» de un día (Francisco revisó la regla en la maqueta, 2026-10-16):
 *  1. toma lo VENCIDO o que vence ese día (nunca lo que vence después: eso no se adelanta solo);
 *  2. un pago por proveedor + sucursal;
 *  3. primero el grupo con la factura más vieja; empate → el de mayor monto;
 *  4. llena hasta `room` (el disponible del día); lo que no cabe se marca `fits: false`.
 * Sin fecha de vencimiento no entra: no se puede decir que ya venció.
 */
export function sugerirArmado<T extends GroupableObligation>(obligations: readonly T[], date: string, room: number): ArmadoGrupo<T>[] {
  const due = obligations.filter((o) => { const d = dueOf(o); return d != null && d <= date; });
  const byKey = new Map<string, T[]>();
  for (const o of due) { const k = obligationKey(o); (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(o); }
  const groups = [...byKey.entries()].map(([key, items]) => {
    items.sort((a, b) => dueOf(a)!.localeCompare(dueOf(b)!));
    return { key, beneficiary: items[0].beneficiary, branch: items[0].branch_code ?? null, items,
      total: items.reduce((s, o) => s + Number(o.available_amount), 0), oldest: dueOf(items[0])!, fits: false };
  }).sort((a, b) => a.oldest.localeCompare(b.oldest) || b.total - a.total);
  let left = room;
  for (const g of groups) { g.fits = g.total <= left + 0.005; if (g.fits) left -= g.total; }
  return groups;
}
const dueOf = (o: GroupableObligation): string | null => vencimiento(o);

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
